import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

// Host-owned GENERIC inbound-webhook route (cinatra#340).
//
//   POST /webhook/<vendor>/<slug>/<hook>/<bindingId>
//
// One route for EVERY webhook-bearing connector. It imports NO connector
// package and never branches on vendor/slug — it resolves the declared hook
// from the generated registry, resolves the per-binding secret + per-site
// identity from the SERVER-ISSUED opaque bindingId (NEVER the payload),
// verifies the Standard-Webhooks signature, guards replays through the leased
// idempotency ledger, delegates to the connector's handler, and normalizes the
// business outcome to HTTP.
//
// Two auth modes per binding: the forward-default Standard-Webhooks signature,
// and the #343 LEGACY bridge (D3c option A) — a binding flagged legacyEnabled
// keeps its in-field sender's bespoke `sha256=<hex>` HMAC (the deployed
// WordPress plugin) plus a required X-Cinatra-Webhook-Id idempotency key, so no
// synchronized plugin rollout is needed. Both arms rejoin the shared
// idempotency-ledger → dispatch → finalize path.
//
// The route stays INERT for any hook no extension declares: the registry is
// empty until a connector ships cinatra.webhooks (the live WordPress declaration
// lands in wordpress-mcp-connector + a host regenerate), so every undeclared
// request 404s at the resolve step (the empty-registry path is crash-free).

import {
  verifyInbound,
  verifyLegacyHmac,
  WebhookVerifyFailedError,
  webhookScopeKey,
  type VerifiedWebhook,
  type WebhookContext,
  type WebhookHandlerOutcome,
} from "@cinatra-ai/webhooks";
import { resolveWebhook, buildWebhookHandler } from "@/lib/webhook-registry.server";
import { webhookSecretService } from "@/lib/webhook-secret-service";
import { getWebhookIdempotencyLedger } from "@/lib/webhook-idempotency.server";

export const dynamic = "force-dynamic";

// #343 legacy-bridge headers (the in-field WordPress plugin's bespoke signing).
// The plugin signs the raw body with `X-Cinatra-Sig-256: sha256=<hmac-hex>` and
// carries no Standard-Webhooks `webhook-id`; we require an explicit
// `X-Cinatra-Webhook-Id` to key the idempotency ledger (fail closed if absent).
const LEGACY_SIG_HEADER = "x-cinatra-sig-256";
const LEGACY_WEBHOOK_ID_HEADER = "x-cinatra-webhook-id";

// Cap the raw body read. A webhook payload is small JSON; an unbounded
// arrayBuffer() read is a memory-exhaustion vector, so we stream with a running
// total and abort the moment the cap is exceeded.
const MAX_BODY_BYTES = 256 * 1024;

// Read the raw request bytes with a hard cap. Returns null when the cap is
// exceeded (the caller responds 413) — we never buffer past the limit.
async function readCappedRawBody(request: Request): Promise<Buffer | null> {
  // Cheap early reject on a declared Content-Length over the cap.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return null;
  }
  const body = request.body;
  if (!body) {
    // No stream (e.g. an empty body) — fall back to a bounded arrayBuffer.
    const buf = Buffer.from(await request.arrayBuffer());
    return buf.byteLength > MAX_BODY_BYTES ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

interface RouteParams {
  params: Promise<{ vendor: string; slug: string; hook: string; bindingId: string }>;
}

// Accept ONLY application/json (and a structured `+json` suffix, e.g.
// application/vnd.acme+json). The media type is parsed from the Content-Type
// header — the bare type/subtype before any `;` parameter — so a value like
// `text/plain; note=application/json` is correctly REJECTED (the loose
// `.includes("application/json")` check would have wrongly accepted it).
// A well-formed `type/subtype` whose subtype is `json` or ends in the `+json`
// structured suffix (RFC 6839). Anchored, so a bare `+json` / `foo+json` with
// no `/` is REJECTED — only a real media type passes.
const JSON_MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/;
function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const mediaType = header.split(";", 1)[0].trim().toLowerCase();
  return JSON_MEDIA_TYPE_RE.test(mediaType);
}

export async function POST(request: Request, { params }: RouteParams) {
  const { vendor, slug, hook, bindingId } = await params;

  // 1. Resolve the declared hook FIRST — an undeclared hook is a clean 404
  // (NEVER a silent 200), BEFORE any media-type / body-size validation, so an
  // empty/undeclared registry can never leak a 415/413. This upholds #340's
  // invariant that every request to an undeclared hook 404s at the resolve
  // step. This is also the empty-registry path (inert until #343).
  const entry = resolveWebhook(vendor, slug, hook);
  if (!entry) {
    return NextResponse.json(
      { error: "No such webhook.", code: "webhook-not-found" },
      { status: 404 },
    );
  }
  const scope = webhookScopeKey(vendor, slug, hook);

  // 2. Content-type + body-size gates (only for a DECLARED hook; before any
  // DB / crypto work).
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return NextResponse.json(
      { error: "Webhook payloads must be application/json.", code: "unsupported-media-type" },
      { status: 415 },
    );
  }
  const rawBody = await readCappedRawBody(request);
  if (rawBody === null) {
    return NextResponse.json(
      { error: "Payload too large.", code: "payload-too-large" },
      { status: 413 },
    );
  }

  // 3. Resolve the binding by the OPAQUE bindingId ONLY (never the payload).
  // Unknown/revoked → 401 with no oracle; the binding's tuple must match the
  // path or 401 (a binding can only serve the hook it was minted for).
  const binding = await webhookSecretService.resolveByBindingId(bindingId);
  if (
    !binding ||
    binding.vendor !== vendor ||
    binding.slug !== slug ||
    binding.hook !== hook
  ) {
    return NextResponse.json(
      { error: "Webhook authentication failed.", code: "webhook-unauthorized" },
      { status: 401 },
    );
  }

  // 4. Authenticate. The forward DEFAULT is Standard-Webhooks (legacyEnabled
  // false). A LEGACY-bridge binding (#343 D3c option A) keeps the in-field
  // sender's bespoke `sha256=<hex>` HMAC — it must NOT be fed through
  // verifyInbound (which would always fail the Standard-Webhooks header check),
  // so we branch on legacyEnabled FIRST and only verifyInbound otherwise. Both
  // arms produce the same `verified` shape and rejoin the shared
  // claim → dispatch → finalize path below.
  let verified: { messageId: string; timestamp: Date; payload: unknown };
  if (binding.legacyEnabled) {
    // Legacy arm. The legacy sender carries no Standard-Webhooks webhook-id, so
    // an explicit idempotency-key header is REQUIRED — absent → fail closed
    // (same no-oracle 401 as a bad signature, so a probe cannot distinguish
    // "no id" from "bad sig"). The header is part of the sender CONTRACT but is
    // NOT the dedupe key: the legacy HMAC authenticates ONLY the raw body (not
    // the headers), so trusting the header value to key the ledger would let
    // anyone who captures one valid signed body replay it with a fresh
    // X-Cinatra-Webhook-Id and bypass dedupe → repeated dispatch of the same
    // authenticated event. Standard-Webhooks avoids this because its webhook-id
    // is inside the signed content; the legacy HMAC is not. So we derive the
    // ledger messageId from AUTHENTICATED material — a digest of the exact
    // signed bytes — which is replay-stable (a true retry of the same event
    // dedupes) and unforgeable (the body is HMAC-bound).
    const idHeader = request.headers.get(LEGACY_WEBHOOK_ID_HEADER);
    const sigHeader = request.headers.get(LEGACY_SIG_HEADER);
    // binding.legacySecret is guaranteed present for a legacyEnabled binding
    // (the secret service fails closed otherwise) — defensively treat a missing
    // one as an auth failure rather than feeding undefined into the verifier.
    if (
      typeof idHeader !== "string" ||
      idHeader.length === 0 ||
      typeof binding.legacySecret !== "string" ||
      !verifyLegacyHmac(rawBody, sigHeader, binding.legacySecret)
    ) {
      console.warn(
        `[webhook:${scope}] legacy signature verification failed (ua=${request.headers.get("user-agent") ?? "?"})`,
      );
      return NextResponse.json(
        { error: "Webhook authentication failed.", code: "webhook-unauthorized" },
        { status: 401 },
      );
    }
    // Synthesize the verified shape from the authenticated legacy request. The
    // body was authenticated by the HMAC over the exact bytes, so JSON.parse of
    // the same bytes is the verified payload; a non-JSON body is an auth-context
    // failure (the sender's contract is JSON) → 400.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return NextResponse.json(
        { error: "Webhook payload is not valid JSON.", code: "invalid-payload" },
        { status: 400 },
      );
    }
    // Authenticated idempotency key: sha256 of the exact signed bytes, prefixed
    // to namespace it from any Standard-Webhooks messageId. The unsigned header
    // is required (above) but never trusted as the dedupe key.
    const messageId =
      "sha256:" + createHash("sha256").update(rawBody).digest("hex");
    verified = { messageId, timestamp: new Date(), payload };
  } else {
    // Standard-Webhooks arm — verify against the binding's candidate secrets
    // (current, then a non-expired previous during a rotation window).
    try {
      verified = verifyInbound(rawBody, request.headers, binding.secrets);
    } catch (err) {
      if (err instanceof WebhookVerifyFailedError) {
        // Log the user-agent for triage; NEVER echo a secret or the payload.
        console.warn(
          `[webhook:${scope}] signature verification failed (ua=${request.headers.get("user-agent") ?? "?"})`,
        );
        return NextResponse.json(
          { error: "Webhook authentication failed.", code: "webhook-unauthorized" },
          { status: 401 },
        );
      }
      throw err;
    }
  }

  // 5. Leased idempotency CLAIM (the atomic UPSERT state machine).
  const ledger = getWebhookIdempotencyLedger();
  const claim = await ledger.claim(scope, binding.siteId, verified.messageId);
  if (claim.kind === "deduped") {
    return NextResponse.json({ deduped: true }, { status: 200 });
  }
  if (claim.kind === "in-progress") {
    // A live-lease holder is processing the same message — the sender retries.
    return NextResponse.json(
      { error: "A delivery of this webhook is already being processed.", code: "webhook-in-progress" },
      { status: 409 },
    );
  }

  // 6. Build the verified context (verified siteId + least-privilege services).
  const webhook: VerifiedWebhook = {
    vendor,
    slug,
    hook,
    bindingId,
    siteId: binding.siteId,
    messageId: verified.messageId,
    timestamp: verified.timestamp,
    rawBody,
    payload: verified.payload,
  };
  const context: WebhookContext = {
    webhook,
    log: (message, fields) => console.log(`[webhook:${scope}] ${message}`, fields ?? {}),
  };

  // 7. Delegate to the connector's handler (FAIL-LOUD build). The handler
  // re-validates the payload with its OWN schema and returns an outcome.
  let outcome: WebhookHandlerOutcome;
  try {
    const handler = await buildWebhookHandler(scope, entry);
    outcome = await handler(context);
  } catch (err) {
    // A handler crash / un-importable handler is a RETRYABLE failure: mark the
    // ledger failed (attempt-fenced) so a retry re-claims, and 503.
    console.error(`[webhook:${scope}] handler error:`, err instanceof Error ? err.message : err);
    await ledger.finalize(scope, binding.siteId, verified.messageId, claim.attemptCount, "failed");
    return NextResponse.json(
      { error: "Temporary webhook processing failure.", code: "webhook-retryable" },
      { status: 503 },
    );
  }

  // 8. Finalize the ledger + normalize the outcome to HTTP (attempt-fenced).
  // For a TERMINAL outcome (accepted/ignored/rejected → done) we only emit the
  // terminal HTTP response when THIS holder's finalize wins the fence. A stale
  // holder whose lease expired and was reclaimed by a newer attempt gets
  // finalize=false here; it must NOT report success (the live holder owns the
  // row and its verdict stands) — we return 503 so the SENDER keeps retrying
  // until a winning holder's verdict is recorded (codex: a stale holder
  // reporting 200/204/4xx while the ledger stays non-terminal can let the
  // sender stop retrying and admit later duplicate processing).
  const supersededResponse = () =>
    NextResponse.json(
      { error: "Temporary webhook processing failure.", code: "webhook-retryable" },
      { status: 503 },
    );

  switch (outcome.outcome) {
    case "accepted":
    case "ignored": {
      const won = await ledger.finalize(scope, binding.siteId, verified.messageId, claim.attemptCount, "done");
      if (!won) return supersededResponse();
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    case "rejected": {
      const won = await ledger.finalize(scope, binding.siteId, verified.messageId, claim.attemptCount, "done");
      if (!won) return supersededResponse();
      // Default 204 (well-formed + authentic but semantically refused); an
      // opt-in manifest rejectStatus (validated 400-499) overrides.
      const status =
        typeof entry.rejectStatus === "number" ? entry.rejectStatus : 204;
      return status === 204
        ? new NextResponse(null, { status: 204 })
        : NextResponse.json({ rejected: true }, { status });
    }
    case "retryable":
    default: {
      // A failed finalize that loses the fence is harmless here (the row is
      // already non-terminal under a newer attempt) — either way the sender
      // should retry, so a 503 is correct regardless of the fence result.
      await ledger.finalize(scope, binding.siteId, verified.messageId, claim.attemptCount, "failed");
      return supersededResponse();
    }
  }
}
