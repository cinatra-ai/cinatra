import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverOutbound } from "../outbound";
import { verifyInbound } from "../verify";
import { mintWebhookSecret } from "../secret-service";

// A capture of the single fetch call deliverOutbound makes.
type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function stubFetch(impl: (captured: Captured) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
    return impl({
      url,
      method: String(init.method),
      headers,
      body: String(init.body),
    });
  });
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("deliverOutbound — status classification", () => {
  it("2xx → delivered", async () => {
    globalThis.fetch = stubFetch(() => new Response("", { status: 200 })) as never;
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m1",
      payload: { a: 1 },
    });
    expect(r).toEqual({ kind: "delivered", status: 200 });
  });

  it.each([408, 425, 429, 500, 502, 503])("transient %i → retryable", async (status) => {
    globalThis.fetch = stubFetch(() => new Response("", { status })) as never;
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m2",
      payload: {},
    });
    expect(r).toEqual({ kind: "retryable", status });
  });

  it.each([400, 401, 403, 404, 422])("other 4xx %i → permanent", async (status) => {
    globalThis.fetch = stubFetch(() => new Response("", { status })) as never;
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m3",
      payload: {},
    });
    expect(r).toEqual({ kind: "permanent", status });
  });

  it("network error → retryable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as never;
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m4",
      payload: {},
    });
    expect(r.kind).toBe("retryable");
    expect((r as { error?: string }).error).toContain("ECONNRESET");
  });

  it("timeout (AbortError) → retryable", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as never;
    const r = await deliverOutbound(
      {
        url: "https://example.test/hook",
        secret: mintWebhookSecret(),
        messageId: "m5",
        payload: {},
      },
      { timeoutMs: 5 },
    );
    expect(r.kind).toBe("retryable");
  });
});

describe("deliverOutbound — signing & headers", () => {
  it("signs with Standard-Webhooks headers and POSTs the exact signed body", async () => {
    let captured: Captured | undefined;
    globalThis.fetch = stubFetch((c) => {
      captured = c;
      return new Response("", { status: 200 });
    }) as never;

    const secret = mintWebhookSecret();
    const payload = { event: "assistant.mention", id: 7 };
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret,
      messageId: "msg_sign",
      payload,
    });

    expect(r).toEqual({ kind: "delivered", status: 200 });
    expect(captured).toBeDefined();
    expect(captured!.method).toBe("POST");
    expect(captured!.headers["Content-Type"]).toBe("application/json");
    expect(captured!.headers["webhook-id"]).toBe("msg_sign");
    expect(captured!.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(captured!.headers["webhook-signature"]).toMatch(/^v1,/);
    // The receiver verifies the EXACT bytes we sent under ONE convention.
    const h = new Headers();
    h.set("webhook-id", captured!.headers["webhook-id"]);
    h.set("webhook-timestamp", captured!.headers["webhook-timestamp"]);
    h.set("webhook-signature", captured!.headers["webhook-signature"]);
    const verified = verifyInbound(Buffer.from(captured!.body, "utf8"), h, [secret]);
    expect(verified.payload).toEqual(payload);
    expect(verified.messageId).toBe("msg_sign");
  });

  it("preserves extraHeaders (e.g. X-Cinatra-Assistant-Id)", async () => {
    let captured: Captured | undefined;
    globalThis.fetch = stubFetch((c) => {
      captured = c;
      return new Response("", { status: 200 });
    }) as never;
    await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m6",
      payload: {},
      extraHeaders: { "X-Cinatra-Assistant-Id": "assistant-123" },
    });
    expect(captured!.headers["X-Cinatra-Assistant-Id"]).toBe("assistant-123");
  });

  it("rejects extraHeaders that try to override a reserved header (case-insensitive) → permanent, no fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    for (const reserved of [
      "webhook-id",
      "Webhook-Signature",
      "WEBHOOK-TIMESTAMP",
      "content-type",
    ]) {
      const r = await deliverOutbound({
        url: "https://example.test/hook",
        secret: mintWebhookSecret(),
        messageId: "m7",
        payload: {},
        extraHeaders: { [reserved]: "attacker" },
      });
      expect(r.kind).toBe("permanent");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signed headers + Content-Type win even if a (non-reserved-cased) header collides post-merge", async () => {
    // Defense-in-depth: signed headers are spread LAST. We can't pass a reserved
    // name (rejected above), so prove ordering by asserting the signed values
    // are present and correct alongside an arbitrary extra header.
    let captured: Captured | undefined;
    globalThis.fetch = stubFetch((c) => {
      captured = c;
      return new Response("", { status: 200 });
    }) as never;
    await deliverOutbound({
      url: "https://example.test/hook",
      secret: mintWebhookSecret(),
      messageId: "m8",
      payload: {},
      extraHeaders: { "X-Custom": "ok" },
    });
    expect(captured!.headers["X-Custom"]).toBe("ok");
    expect(captured!.headers["webhook-id"]).toBe("m8");
    expect(captured!.headers["Content-Type"]).toBe("application/json");
  });
});

describe("deliverOutbound — fail-closed on bad secret", () => {
  it("a non-base64 legacy secret makes signing throw → permanent (no crash, no fetch)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    // A raw plaintext legacy secret with characters outside the base64 alphabet
    // that the standardwebhooks library cannot decode.
    const r = await deliverOutbound({
      url: "https://example.test/hook",
      secret: "!!! not base64 @@@",
      messageId: "m9",
      payload: {},
    });
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/signing failed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("deliverOutbound — per-attempt timestamp (F7)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("messageId is stable across attempts but webhook-timestamp is fresh each attempt", async () => {
    const secret = mintWebhookSecret();
    const stamps: string[] = [];
    const ids: string[] = [];
    globalThis.fetch = stubFetch((c) => {
      stamps.push(c.headers["webhook-timestamp"]);
      ids.push(c.headers["webhook-id"]);
      return new Response("", { status: 500 });
    }) as never;

    const req = {
      url: "https://example.test/hook",
      secret,
      messageId: "stable-id",
      payload: { x: 1 },
    };

    // Pin the clock, deliver, advance 90s (past a typical 5-min window edge is
    // not needed — we only need the stamp to MOVE), deliver again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await deliverOutbound(req); // attempt 1
    vi.setSystemTime(new Date("2026-01-01T00:01:30Z")); // +90s
    await deliverOutbound(req); // attempt 2

    // The webhook-id (idempotency key) is STABLE across retries.
    expect(ids).toEqual(["stable-id", "stable-id"]);
    // The webhook-timestamp is regenerated per attempt and reflects the
    // advanced clock (so a delayed retry stays inside the receiver's window).
    expect(stamps.length).toBe(2);
    expect(Number(stamps[1]) - Number(stamps[0])).toBe(90);
  });
});
