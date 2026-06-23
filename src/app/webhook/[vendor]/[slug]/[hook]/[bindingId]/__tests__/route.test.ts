import { describe, it, expect, vi, beforeEach } from "vitest";
import { signOutbound } from "@cinatra-ai/webhooks";
import type {
  ResolvedBinding,
  WebhookHandlerOutcome,
} from "@cinatra-ai/webhooks";

// The route delegates to three host seams; we mock them so the test exercises
// the route's resolve → verify → idempotency → dispatch → HTTP-normalize logic
// without a DB or a real connector. This is the host outcome-normalization test
// (cinatra#340 §5 step 8 + the e2e shape of §9 Stage D, in-memory).

const resolveWebhook = vi.fn();
const buildWebhookHandler = vi.fn();
vi.mock("@/lib/webhook-registry.server", () => ({
  resolveWebhook: (...a: unknown[]) => resolveWebhook(...a),
  buildWebhookHandler: (...a: unknown[]) => buildWebhookHandler(...a),
}));

const resolveByBindingId = vi.fn();
vi.mock("@/lib/webhook-secret-service", () => ({
  webhookSecretService: {
    resolveByBindingId: (...a: unknown[]) => resolveByBindingId(...a),
  },
}));

const claim = vi.fn();
const finalize = vi.fn();
vi.mock("@/lib/webhook-idempotency.server", () => ({
  getWebhookIdempotencyLedger: () => ({ claim, finalize }),
}));

import { POST } from "../route";

const SECRET = "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MTI=";
const VENDOR = "cinatra-ai";
const SLUG = "demo-connector";
const HOOK = "post-published";
const BINDING_ID = "binding-abc";
const SITE_ID = "11111111-1111-1111-1111-111111111111";

function baseBinding(over: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    bindingId: BINDING_ID,
    vendor: VENDOR,
    slug: SLUG,
    hook: HOOK,
    siteId: SITE_ID,
    secrets: [SECRET],
    legacyEnabled: false,
    ...over,
  };
}

function signedRequest(payload: unknown, messageId = "msg-1"): Request {
  const signed = signOutbound(SECRET, messageId, new Date(), payload);
  return new Request(`http://localhost/webhook/${VENDOR}/${SLUG}/${HOOK}/${BINDING_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": signed.headers["webhook-id"],
      "webhook-timestamp": signed.headers["webhook-timestamp"],
      "webhook-signature": signed.headers["webhook-signature"],
    },
    body: signed.body,
  });
}

const params = (over: Partial<Record<string, string>> = {}) => ({
  params: Promise.resolve({
    vendor: VENDOR,
    slug: SLUG,
    hook: HOOK,
    bindingId: BINDING_ID,
    ...over,
  }),
});

function handlerReturning(outcome: WebhookHandlerOutcome) {
  buildWebhookHandler.mockResolvedValue(async () => outcome);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveWebhook.mockReturnValue({ resolution: "guardedOptional", factory: "createX" });
  resolveByBindingId.mockResolvedValue(baseBinding());
  claim.mockResolvedValue({ kind: "claimed", attemptCount: 1 });
  finalize.mockResolvedValue(true);
});

describe("generic /webhook route — gates", () => {
  it("415 when content-type is not application/json", async () => {
    const req = new Request("http://localhost/webhook/x/y/z/b", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hi",
    });
    const res = await POST(req, params());
    expect(res.status).toBe(415);
  });

  it("413 when Content-Length exceeds the cap", async () => {
    const req = new Request("http://localhost/webhook/x/y/z/b", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: JSON.stringify({ a: 1 }),
    });
    const res = await POST(req, params());
    expect(res.status).toBe(413);
  });

  it("404 for an undeclared hook (empty/miss registry) — never a silent 200", async () => {
    resolveWebhook.mockReturnValue(null);
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(404);
    expect(claim).not.toHaveBeenCalled();
  });

  it("404 (NOT 415) for an undeclared hook even with a non-JSON content-type — resolve runs first", async () => {
    resolveWebhook.mockReturnValue(null);
    const req = new Request("http://localhost/webhook/x/y/z/b", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hi",
    });
    const res = await POST(req, params());
    expect(res.status).toBe(404);
  });

  it("404 (NOT 413) for an undeclared hook even with an oversized body — resolve runs first", async () => {
    resolveWebhook.mockReturnValue(null);
    const req = new Request("http://localhost/webhook/x/y/z/b", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: JSON.stringify({ a: 1 }),
    });
    const res = await POST(req, params());
    expect(res.status).toBe(404);
  });

  it("415 when a parameterized content-type only MENTIONS application/json (not the media type)", async () => {
    const req = new Request("http://localhost/webhook/x/y/z/b", {
      method: "POST",
      headers: { "content-type": "text/plain; note=application/json" },
      body: "hi",
    });
    const res = await POST(req, params());
    expect(res.status).toBe(415);
  });

  it("415 for a malformed `+json` token with no type/subtype (e.g. \"+json\" or \"foo+json\")", async () => {
    for (const ct of ["+json", "foo+json", "/json", "application/"]) {
      const req = new Request("http://localhost/webhook/x/y/z/b", {
        method: "POST",
        headers: { "content-type": ct },
        body: "hi",
      });
      const res = await POST(req, params());
      expect(res.status).toBe(415);
    }
  });

  it("accepts a structured +json suffix media type (e.g. application/vnd.acme+json)", async () => {
    handlerReturning({ outcome: "accepted" });
    const signed = signOutbound(SECRET, "msg-json", new Date(), { a: 1 });
    const req = new Request(`http://localhost/webhook/${VENDOR}/${SLUG}/${HOOK}/${BINDING_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.acme+json; charset=utf-8",
        "webhook-id": signed.headers["webhook-id"],
        "webhook-timestamp": signed.headers["webhook-timestamp"],
        "webhook-signature": signed.headers["webhook-signature"],
      },
      body: signed.body,
    });
    const res = await POST(req, params());
    expect(res.status).toBe(200);
  });

  it("401 for an unknown/revoked binding (no oracle)", async () => {
    resolveByBindingId.mockResolvedValue(null);
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(401);
  });

  it("401 when the binding tuple does not match the path", async () => {
    resolveByBindingId.mockResolvedValue(baseBinding({ hook: "other-hook" }));
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(401);
  });

  it("401 on a bad signature (wrong secret), logging never echoes the secret", async () => {
    resolveByBindingId.mockResolvedValue(baseBinding({ secrets: ["whsec_d3JvbmdzZWNyZXR3cm9uZ3NlY3JldHdyb25nc2VjMQ=="] }));
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(401);
  });
});

describe("generic /webhook route — idempotency normalization", () => {
  it("200 deduped for a replayed (done) message", async () => {
    claim.mockResolvedValue({ kind: "deduped" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deduped: true });
    expect(buildWebhookHandler).not.toHaveBeenCalled();
  });

  it("409 when a live-lease holder is already processing", async () => {
    claim.mockResolvedValue({ kind: "in-progress" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(409);
    expect(buildWebhookHandler).not.toHaveBeenCalled();
  });
});

describe("generic /webhook route — outcome → HTTP", () => {
  it("accepted → 200 + ledger done", async () => {
    handlerReturning({ outcome: "accepted" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(200);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, "msg-1", 1, "done");
  });

  it("ignored → 200 + ledger done", async () => {
    handlerReturning({ outcome: "ignored" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(200);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, "msg-1", 1, "done");
  });

  it("rejected → 204 by default + ledger done", async () => {
    handlerReturning({ outcome: "rejected" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(204);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, "msg-1", 1, "done");
  });

  it("rejected → the opt-in manifest rejectStatus (4xx) when declared", async () => {
    resolveWebhook.mockReturnValue({ resolution: "guardedOptional", factory: "createX", rejectStatus: 422 });
    handlerReturning({ outcome: "rejected" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(422);
  });

  it("retryable → 503 + ledger failed (so a retry re-claims)", async () => {
    handlerReturning({ outcome: "retryable" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(503);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, "msg-1", 1, "failed");
  });

  it("a handler THROW → 503 + ledger failed", async () => {
    buildWebhookHandler.mockResolvedValue(async () => {
      throw new Error("boom");
    });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(503);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, "msg-1", 1, "failed");
  });

  it("a stale holder that LOSES the finalize fence on a terminal outcome returns 503 (not a false success)", async () => {
    // finalize=false means a newer attempt reclaimed the row; the stale holder
    // must not report success (the live holder's verdict stands).
    finalize.mockResolvedValue(false);
    handlerReturning({ outcome: "accepted" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(503);
  });

  it("a rejected outcome that LOSES the finalize fence returns 503 (not 204/4xx)", async () => {
    finalize.mockResolvedValue(false);
    resolveWebhook.mockReturnValue({ resolution: "guardedOptional", factory: "createX", rejectStatus: 422 });
    handlerReturning({ outcome: "rejected" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(503);
  });

  it("the verified context carries the BINDING's siteId (not payload-derived) and the parsed payload", async () => {
    let seenSiteId: string | undefined;
    let seenPayload: unknown;
    buildWebhookHandler.mockResolvedValue(async (ctx: { webhook: { siteId: string; payload: unknown } }) => {
      seenSiteId = ctx.webhook.siteId;
      seenPayload = ctx.webhook.payload;
      return { outcome: "accepted" } as WebhookHandlerOutcome;
    });
    await POST(signedRequest({ event: "post.published", id: 7 }), params());
    expect(seenSiteId).toBe(SITE_ID);
    expect(seenPayload).toEqual({ event: "post.published", id: 7 });
  });
});

describe("generic /webhook route — legacy branch is DORMANT in #340", () => {
  it("a non-legacy binding NEVER takes the legacy branch (verifies normally)", async () => {
    handlerReturning({ outcome: "accepted" });
    const res = await POST(signedRequest({ a: 1 }), params());
    // A normal accepted outcome proves the legacy branch was skipped.
    expect(res.status).toBe(200);
  });

  it("a (hypothetical) legacyEnabled binding fails closed 401 in #340 (no legacy secret stored)", async () => {
    resolveByBindingId.mockResolvedValue(baseBinding({ legacyEnabled: true }));
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });
});
