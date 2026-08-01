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
