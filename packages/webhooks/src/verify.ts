// Standard-Webhooks INBOUND verification (cinatra#340).
//
// Wraps the `standardwebhooks` library's `Webhook(secret).verify(body, headers)`
// — promoted to a DIRECT dependency by this issue. The route resolves the
// candidate secret(s) for an opaque server-issued binding id (current, then a
// non-expired previous during a rotation window) and hands them here; we try
// each in turn so a webhook signed under either side of a rotation verifies.
//
// Two library contracts that bite if ignored (both empirically confirmed
// against standardwebhooks@1.0.0):
//   1. `verify(payload, headers)` indexes a PLAIN object by the lowercased
//      header names `webhook-id` / `webhook-timestamp` / `webhook-signature`.
//      A Fetch `Headers` instance passed directly mis-reads every field as
//      missing → a spurious "Missing required headers" throw. So we normalize
//      to a plain `Record<string,string>` from `headers.get(...)` FIRST.
//   2. `verify` THROWS `WebhookVerificationError` on any failure (bad sig,
//      missing header, stale/future timestamp) and otherwise returns the parsed
//      JSON payload. We surface the parsed payload on success and re-throw the
//      LAST error when every candidate secret fails.

import { createHmac, timingSafeEqual } from "node:crypto";

import { Webhook } from "standardwebhooks";

export interface VerifiedInbound {
  /** Standard-Webhooks `webhook-id`. */
  readonly messageId: string;
  /** Standard-Webhooks `webhook-timestamp`, as a Date. */
  readonly timestamp: Date;
  /** The parsed JSON payload returned by the library on a successful verify. */
  readonly payload: unknown;
}

/** Thrown when verification fails under EVERY candidate secret. */
export class WebhookVerifyFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerifyFailedError";
  }
}

// The three Standard-Webhooks required headers. Lowercased — the library
// re-lowercases internally but we build the plain object deterministically so
// a missing header is a clean undefined (→ library's own "missing" throw)
// rather than a TypeError reading off a Headers instance.
function toPlainHeaders(headers: Headers): Record<string, string> {
  const plain: Record<string, string> = {};
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"] as const) {
    const value = headers.get(name);
    if (value !== null) plain[name] = value;
  }
  return plain;
}

/**
 * Verify a raw inbound webhook body against one or more candidate secrets.
 *
 * @param rawBody  The exact request bytes (the bytes that were signed).
 * @param headers  The Fetch request headers (normalized internally).
 * @param secrets  Candidate secrets in priority order (current, then a
 *                 non-expired previous during a rotation window). Standard-
 *                 Webhooks base64 secrets, with or without the `whsec_` prefix.
 * @returns the verified `{ messageId, timestamp, payload }`.
 * @throws {@link WebhookVerifyFailedError} when no candidate secret verifies,
 *   or when `secrets` is empty.
 */
export function verifyInbound(
  rawBody: Buffer,
  headers: Headers,
  secrets: readonly string[],
): VerifiedInbound {
  if (secrets.length === 0) {
    throw new WebhookVerifyFailedError("no candidate secret available for this binding");
  }
  const plainHeaders = toPlainHeaders(headers);
  const messageId = plainHeaders["webhook-id"];
  const timestampHeader = plainHeaders["webhook-timestamp"];
  const body = rawBody.toString("utf8");

  let lastError: unknown;
  for (const secret of secrets) {
    try {
      const payload = new Webhook(secret).verify(body, plainHeaders);
      // The library validated the timestamp header during verify; parse it
      // here for the VerifiedWebhook (seconds-since-epoch per Standard-Webhooks).
      const timestamp = new Date(Number.parseInt(timestampHeader, 10) * 1000);
      return { messageId, timestamp, payload };
    } catch (err) {
      lastError = err;
    }
  }
  // Re-throw a non-secret-bearing error. The library's message names only the
  // failure reason (missing headers / bad signature / stale timestamp), never
  // the secret — but we wrap defensively so callers depend on our type.
  const reason = lastError instanceof Error ? lastError.message : "verification failed";
  throw new WebhookVerifyFailedError(reason);
}

// ---------------------------------------------------------------------------
// Legacy single-shared-secret HMAC bridge (cinatra#343 D3c option A).
//
// The forward default is Standard-Webhooks (`verifyInbound` above). But a
// connector whose IN-FIELD sender predates Standard-Webhooks (the deployed
// WordPress plugin) signs each request with a bespoke `sha256=<hmac-hex>`
// header over the raw body under a single shared secret. Forcing those senders
// to Standard-Webhooks would require a synchronized plugin rollout to every
// live site. The legacy bridge keeps that bespoke HMAC for a binding flagged
// `legacyEnabled` while still routing it through the generic facility (registry
// → leased idempotency ledger → connector handler). The host pairs this verify
// with a REQUIRED caller-supplied idempotency-key header (the legacy sender
// carries no Standard-Webhooks `webhook-id`).
//
// This is the SAME constant-time `sha256=<hex>` comparison the host historically
// performed in src/lib/wordpress-widget-auth.verifyWebhookSignature, lifted into
// the package so the bespoke crypto lives in ONE owned place.
// ---------------------------------------------------------------------------

const LEGACY_SIG_PREFIX = "sha256=";

/**
 * Verify a legacy `sha256=<hex>` HMAC-SHA256 signature over the EXACT raw body
 * bytes under a single shared secret, in constant time.
 *
 * @param rawBody   The exact inbound request bytes (the bytes that were signed).
 * @param sigHeader The legacy signature header value (`"sha256=<hex>"`), or null
 *                  when the header is absent (→ false; the caller 401s).
 * @param secret    The single shared HMAC secret stored for the binding.
 * @returns true only when the header is well-formed AND its HMAC matches.
 */
export function verifyLegacyHmac(
  rawBody: Buffer,
  sigHeader: string | null,
  secret: string,
): boolean {
  if (typeof sigHeader !== "string" || !sigHeader.startsWith(LEGACY_SIG_PREFIX)) {
    return false;
  }
  const expected =
    LEGACY_SIG_PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex");
  const presentedBuf = Buffer.from(sigHeader);
  const expectedBuf = Buffer.from(expected);
  // A length mismatch (e.g. a truncated hex) would throw in timingSafeEqual; an
  // early length compare is a non-secret-bearing fast reject (the presented and
  // expected lengths are both derivable from public structure, not the secret).
  if (presentedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(presentedBuf, expectedBuf);
  } catch {
    return false;
  }
}
