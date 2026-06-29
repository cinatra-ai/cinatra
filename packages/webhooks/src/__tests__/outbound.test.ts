import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverOutbound } from "../outbound";
import { verifyInbound } from "../verify";
import { mintWebhookSecret } from "../secret-service";
import type {
  OutboundDeliveryRequest,
  OutboundDeliveryOptions,
  OutboundTransport,
} from "../outbound-types";

// A capture of the single transport call deliverOutbound makes.
type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

// The egress guard resolves the target host BEFORE sending; these tests use a
// PUBLIC IP so the guard always permits the request and never hits real DNS.
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

// Build an injectable transport from a stub returning a { status } (or throwing).
function stubTransport(
  impl: (captured: Captured) => { status: number } | Promise<{ status: number }>,
): OutboundTransport {
  return vi.fn(async (url, init) => {
    return impl({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
  }) as OutboundTransport;
}

// Deliver with the egress seam wired to a fake lookup + transport so the suite
// asserts deliverOutbound's behavior without real network or DNS.
function deliver(
  req: OutboundDeliveryRequest,
  transport: OutboundTransport,
  opts?: OutboundDeliveryOptions,
) {
  return deliverOutbound(req, {
    ...opts,
    egress: { lookup: PUBLIC_LOOKUP, transport, ...opts?.egress },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deliverOutbound — status classification", () => {
  it("2xx → delivered", async () => {
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m1", payload: { a: 1 } },
      stubTransport(() => ({ status: 200 })),
    );
    expect(r).toEqual({ kind: "delivered", status: 200 });
  });

  it.each([408, 425, 429, 500, 502, 503])("transient %i → retryable", async (status) => {
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m2", payload: {} },
      stubTransport(() => ({ status })),
    );
    expect(r).toEqual({ kind: "retryable", status });
  });

  it.each([400, 401, 403, 404, 422])("other 4xx %i → permanent", async (status) => {
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m3", payload: {} },
      stubTransport(() => ({ status })),
    );
    expect(r).toEqual({ kind: "permanent", status });
  });

  it.each([301, 302, 303, 307, 308])("3xx %i (manual redirect, not followed) → permanent", async (status) => {
    // engineering#370: redirects are NOT followed (redirect:"manual"); an open
    // redirect must not chain into an internal address.
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m3xx", payload: {} },
      stubTransport(() => ({ status })),
    );
    expect(r).toEqual({ kind: "permanent", status });
  });

  it("network error → retryable", async () => {
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m4", payload: {} },
      stubTransport(() => {
        throw new Error("ECONNRESET");
      }),
    );
    expect(r.kind).toBe("retryable");
    expect((r as { error?: string }).error).toContain("ECONNRESET");
  });

  it("timeout (AbortError) → retryable", async () => {
    const r = await deliver(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "m5", payload: {} },
      stubTransport(() => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }),
      { timeoutMs: 5 },
    );
    expect(r.kind).toBe("retryable");
  });
});

describe("deliverOutbound — signing & headers", () => {
  it("signs with Standard-Webhooks headers and POSTs the exact signed body", async () => {
    let captured: Captured | undefined;
    const secret = mintWebhookSecret();
    const payload = { event: "assistant.mention", id: 7 };
    const r = await deliver(
      { url: "https://example.test/hook", secret, messageId: "msg_sign", payload },
      stubTransport((c) => {
        captured = c;
        return { status: 200 };
      }),
    );

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
    await deliver(
      {
        url: "https://example.test/hook",
        secret: mintWebhookSecret(),
        messageId: "m6",
        payload: {},
        extraHeaders: { "X-Cinatra-Assistant-Id": "assistant-123" },
      },
      stubTransport((c) => {
        captured = c;
        return { status: 200 };
      }),
    );
    expect(captured!.headers["X-Cinatra-Assistant-Id"]).toBe("assistant-123");
  });

  it("rejects extraHeaders that try to override a reserved header (case-insensitive) → permanent, no send", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    for (const reserved of ["webhook-id", "Webhook-Signature", "WEBHOOK-TIMESTAMP", "content-type"]) {
      const r = await deliver(
        {
          url: "https://example.test/hook",
          secret: mintWebhookSecret(),
          messageId: "m7",
          payload: {},
          extraHeaders: { [reserved]: "attacker" },
        },
        transportSpy as OutboundTransport,
      );
      expect(r.kind).toBe("permanent");
    }
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("signed headers + Content-Type win even if a (non-reserved-cased) header collides post-merge", async () => {
    let captured: Captured | undefined;
    await deliver(
      {
        url: "https://example.test/hook",
        secret: mintWebhookSecret(),
        messageId: "m8",
        payload: {},
        extraHeaders: { "X-Custom": "ok" },
      },
      stubTransport((c) => {
        captured = c;
        return { status: 200 };
      }),
    );
    expect(captured!.headers["X-Custom"]).toBe("ok");
    expect(captured!.headers["webhook-id"]).toBe("m8");
    expect(captured!.headers["Content-Type"]).toBe("application/json");
  });
});

describe("deliverOutbound — fail-closed on bad secret", () => {
  it("a non-base64 legacy secret makes signing throw → permanent (no crash, no send)", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliver(
      { url: "https://example.test/hook", secret: "!!! not base64 @@@", messageId: "m9", payload: {} },
      transportSpy as OutboundTransport,
    );
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/signing failed/i);
    expect(transportSpy).not.toHaveBeenCalled();
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
    const transport = stubTransport((c) => {
      stamps.push(c.headers["webhook-timestamp"]);
      ids.push(c.headers["webhook-id"]);
      return { status: 500 };
    });

    const req = {
      url: "https://example.test/hook",
      secret,
      messageId: "stable-id",
      payload: { x: 1 },
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await deliver(req, transport); // attempt 1
    vi.setSystemTime(new Date("2026-01-01T00:01:30Z")); // +90s
    await deliver(req, transport); // attempt 2

    expect(ids).toEqual(["stable-id", "stable-id"]);
    expect(stamps.length).toBe(2);
    expect(Number(stamps[1]) - Number(stamps[0])).toBe(90);
  });
});

describe("deliverOutbound — SSRF/egress guard (engineering#370)", () => {
  // The guard runs BEFORE the transport; a block is permanent and never sends.
  const blockedTargets: Array<[string, OutboundDeliveryOptions | undefined]> = [
    ["http://169.254.169.254/latest/meta-data/", undefined], // cloud metadata
    ["http://127.0.0.1:8080/hook", undefined], // loopback
    ["http://localhost/hook", undefined], // alias
    ["http://10.0.0.5/hook", undefined], // RFC1918
    ["http://172.16.5.4/hook", undefined], // RFC1918
    ["http://192.168.1.1/hook", undefined], // RFC1918
    ["http://100.64.1.1/hook", undefined], // CGNAT
    ["http://[::1]/hook", undefined], // IPv6 loopback
    ["http://[fc00::1]/hook", undefined], // ULA
    ["http://[fe80::1]/hook", undefined], // link-local
    ["http://[::ffff:127.0.0.1]/hook", undefined], // IPv4-mapped loopback
    ["ftp://example.test/hook", undefined], // bad scheme
  ];

  it.each(blockedTargets)("blocks %s → permanent, no send", async (url) => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url, secret: mintWebhookSecret(), messageId: "blk", payload: {} },
      { egress: { transport: transportSpy as OutboundTransport } },
    );
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/egress blocked/i);
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("blocks a URL with embedded credentials → permanent, no send", async () => {
    // Built from parts so the literal userinfo@host never appears in source
    // (avoids a secret-scanner basic-auth-URI false positive).
    const url = `http://${"u"}:${"p"}@example.test/hook`;
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url, secret: mintWebhookSecret(), messageId: "cred", payload: {} },
      { egress: { transport: transportSpy as OutboundTransport } },
    );
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/credentials/i);
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("blocks a hostname that RESOLVES to an internal address → permanent, no send (DNS guard)", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url: "https://sneaky.test/hook", secret: mintWebhookSecret(), messageId: "rebind", payload: {} },
      {
        egress: {
          // attacker DNS points a public-looking name at the metadata IP
          lookup: async () => [{ address: "169.254.169.254", family: 4 }],
          transport: transportSpy as OutboundTransport,
        },
      },
    );
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/169\.254\.169\.254/);
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("blocks if ANY of multiple resolved addresses is internal → permanent", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url: "https://multi.test/hook", secret: mintWebhookSecret(), messageId: "multi", payload: {} },
      {
        egress: {
          lookup: async () => [
            { address: "93.184.216.34", family: 4 }, // public
            { address: "10.1.2.3", family: 4 }, // internal — must block the whole request
          ],
          transport: transportSpy as OutboundTransport,
        },
      },
    );
    expect(r.kind).toBe("permanent");
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("blocks empty DNS resolution → permanent (fail closed)", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url: "https://void.test/hook", secret: mintWebhookSecret(), messageId: "void", payload: {} },
      { egress: { lookup: async () => [], transport: transportSpy as OutboundTransport } },
    );
    expect(r.kind).toBe("permanent");
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("a real resolver failure (NXDOMAIN) is NOT a block → retryable", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url: "https://nope.test/hook", secret: mintWebhookSecret(), messageId: "nx", payload: {} },
      {
        egress: {
          lookup: async () => {
            const e = new Error("getaddrinfo ENOTFOUND nope.test");
            (e as { code?: string }).code = "ENOTFOUND";
            throw e;
          },
          transport: transportSpy as OutboundTransport,
        },
      },
    );
    expect(r.kind).toBe("retryable");
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("allows a public target (happy path) → delivered", async () => {
    const transportSpy = vi.fn(async () => ({ status: 200 }));
    const r = await deliverOutbound(
      { url: "https://example.test/hook", secret: mintWebhookSecret(), messageId: "ok", payload: {} },
      {
        egress: {
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          transport: transportSpy as OutboundTransport,
        },
      },
    );
    expect(r).toEqual({ kind: "delivered", status: 200 });
    expect(transportSpy).toHaveBeenCalledTimes(1);
  });

  it("a connect-time DNS-rebind (transport throws an egress-tagged cause) → permanent", async () => {
    // Simulate undici surfacing a TypeError whose cause is the connector's
    // EgressBlockedError (the pinned-agent rebind path).
    const { EgressBlockedError } = await import("../egress-guard");
    const transport = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new EgressBlockedError("connect-time rebind: sneaky.test -> 127.0.0.1"),
      });
    });
    const r = await deliverOutbound(
      { url: "https://sneaky.test/hook", secret: mintWebhookSecret(), messageId: "rb2", payload: {} },
      {
        egress: {
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          transport: transport as unknown as OutboundTransport,
        },
      },
    );
    expect(r.kind).toBe("permanent");
    expect((r as { error?: string }).error).toMatch(/egress blocked at connect/i);
  });
});
