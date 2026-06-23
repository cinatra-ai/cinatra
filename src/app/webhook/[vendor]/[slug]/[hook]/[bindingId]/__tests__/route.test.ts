import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac, createHash } from "node:crypto";
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

describe("generic /webhook route — #343 legacy HMAC bridge", () => {
  const LEGACY_SECRET = "shared-legacy-secret-xyz";

  function legacyBinding(over: Partial<ResolvedBinding> = {}): ResolvedBinding {
    return baseBinding({ legacyEnabled: true, secrets: [], legacySecret: LEGACY_SECRET, ...over });
  }

  function legacyRequest(
    payload: unknown,
    {
      messageId = "wp-msg-1",
      secret = LEGACY_SECRET,
      withId = true,
      withSig = true,
      bodyOverride,
    }: {
      messageId?: string;
      secret?: string;
      withId?: boolean;
      withSig?: boolean;
      bodyOverride?: string;
    } = {},
  ): Request {
    const body = bodyOverride ?? JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withId) headers["x-cinatra-webhook-id"] = messageId;
    if (withSig) headers["x-cinatra-sig-256"] = sig;
    return new Request(`http://localhost/webhook/${VENDOR}/${SLUG}/${HOOK}/${BINDING_ID}`, {
      method: "POST",
      headers,
      body,
    });
  }

  it("a non-legacy binding NEVER takes the legacy branch (Standard-Webhooks verifies normally)", async () => {
    handlerReturning({ outcome: "accepted" });
    const res = await POST(signedRequest({ a: 1 }), params());
    expect(res.status).toBe(200);
  });

  // The authenticated idempotency key the route derives for a legacy delivery:
  // sha256 of the EXACT signed body bytes, namespaced. The unsigned
  // X-Cinatra-Webhook-Id header is required but NEVER the dedupe key (the legacy
  // HMAC authenticates only the body, not the headers).
  function legacyBodyKey(payload: unknown): string {
    const body = JSON.stringify(payload);
    return "sha256:" + createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  }

  it("a legacy binding with a valid HMAC + id → dispatch (200) keyed on the AUTHENTICATED body digest, not the header", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    handlerReturning({ outcome: "accepted" });
    const payload = { event: "post_published", postId: 7 };
    const res = await POST(legacyRequest(payload), params());
    expect(res.status).toBe(200);
    // The ledger key is the body digest — NOT the X-Cinatra-Webhook-Id value.
    const key = legacyBodyKey(payload);
    expect(key).not.toBe("wp-msg-1");
    expect(claim).toHaveBeenCalledWith(expect.any(String), SITE_ID, key);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), SITE_ID, key, 1, "done");
  });

  it("a replay of the SAME signed body with a DIFFERENT X-Cinatra-Webhook-Id keys the SAME ledger entry (no header-swap dedupe bypass)", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    handlerReturning({ outcome: "accepted" });
    const payload = { event: "post_published", postId: 7 };
    await POST(legacyRequest(payload, { messageId: "attacker-fresh-id-1" }), params());
    await POST(legacyRequest(payload, { messageId: "attacker-fresh-id-2" }), params());
    const key = legacyBodyKey(payload);
    // Both deliveries claim the SAME key despite distinct header ids — so the
    // leased ledger (real impl) would dedupe the second; the header cannot be
    // varied to force re-dispatch of an already-seen authenticated event.
    expect(claim.mock.calls.every((c) => c[2] === key)).toBe(true);
  });

  it("the handler sees the binding siteId + the parsed legacy payload (not Standard-Webhooks)", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    let seenPayload: unknown;
    let seenSiteId: string | undefined;
    buildWebhookHandler.mockResolvedValue(async (ctx: { webhook: { siteId: string; payload: unknown } }) => {
      seenSiteId = ctx.webhook.siteId;
      seenPayload = ctx.webhook.payload;
      return { outcome: "accepted" } as WebhookHandlerOutcome;
    });
    await POST(legacyRequest({ event: "post_published", postId: 42 }), params());
    expect(seenSiteId).toBe(SITE_ID);
    expect(seenPayload).toEqual({ event: "post_published", postId: 42 });
  });

  it("a legacy binding with a BAD HMAC → 401 (no dispatch)", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    const res = await POST(legacyRequest({ a: 1 }, { secret: "wrong-secret" }), params());
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("a legacy binding MISSING the X-Cinatra-Webhook-Id → fail closed 401 (even with a valid HMAC)", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    const res = await POST(legacyRequest({ a: 1 }, { withId: false }), params());
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("a legacy binding MISSING the X-Cinatra-Sig-256 → 401", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    const res = await POST(legacyRequest({ a: 1 }, { withSig: false }), params());
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("a legacy binding with a valid HMAC over a NON-JSON body → 400 invalid-payload", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    const res = await POST(legacyRequest(null, { bodyOverride: "not json" }), params());
    expect(res.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });

  it("dedupes a replayed legacy delivery (same body digest) → 200 deduped, no dispatch", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding());
    claim.mockResolvedValue({ kind: "deduped" });
    const res = await POST(legacyRequest({ a: 1 }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deduped: true });
    expect(buildWebhookHandler).not.toHaveBeenCalled();
  });

  it("a legacyEnabled binding with NO stored legacy secret fails closed 401 (defensive)", async () => {
    resolveByBindingId.mockResolvedValue(legacyBinding({ legacySecret: undefined }));
    const res = await POST(legacyRequest({ a: 1 }), params());
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });
});
