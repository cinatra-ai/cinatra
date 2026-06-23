// Standard-Webhooks OUTBOUND delivery primitive (cinatra#341).
//
// `deliverOutbound` is the SINGLE outbound signing + HTTP + status-
// classification authority. It is pure (no `server-only`, no host imports): the
// host's BullMQ engine (src/lib/background-jobs.ts) owns scheduling, retry, and
// the dead-letter table; this module just signs ONE request via the #340
// `signOutbound` and reports back a discriminated `OutboundDeliveryResult`.
//
// ONE convention: the signature scheme here is byte-identical to what
// `verifyInbound` (verify.ts) checks, so a cinatra→cinatra round-trip verifies.
// (Covered by outbound.test.ts.)

import { signOutbound } from "./sign";
import type {
  OutboundDeliveryRequest,
  OutboundDeliveryOptions,
  OutboundDeliveryResult,
} from "./outbound-types";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Header names the SIGNED set + Content-Type own. `extraHeaders` may not carry
 * any of these (case-insensitive) — a producer that tries to is a programming
 * error and the request is classified `permanent` (never silently overridden).
 */
const RESERVED_HEADER_NAMES = new Set([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "content-type",
]);

/**
 * Deliver one signed outbound webhook.
 *
 * Status classification:
 *   - 2xx                         → delivered
 *   - 408 / 425 / 429 / 5xx       → retryable (transient/overload)
 *   - network error / timeout     → retryable
 *   - any other 4xx               → permanent (a client-contract error; retrying
 *                                    the same bytes will keep failing)
 *   - signing throws (bad secret) → permanent (fail-closed; never crash)
 *   - reserved-header collision   → permanent (producer bug)
 *
 * `webhook-timestamp` is generated HERE at call time (`new Date()`) so a
 * delayed retry presents a FRESH timestamp inside the receiver's tolerance
 * window, while `messageId` (the `webhook-id`/idempotency key) stays STABLE
 * across retries (cinatra#341 F7).
 */
export async function deliverOutbound(
  req: OutboundDeliveryRequest,
  opts?: OutboundDeliveryOptions,
): Promise<OutboundDeliveryResult> {
  // Reject reserved-header overrides up front (case-insensitive). A producer
  // supplying webhook-* / content-type via extraHeaders is a bug; we never let
  // it shadow the signed set, and we surface it as a permanent failure rather
  // than silently dropping the header.
  if (req.extraHeaders) {
    for (const name of Object.keys(req.extraHeaders)) {
      if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
        return {
          kind: "permanent",
          error: `extraHeaders may not override reserved header "${name}"`,
        };
      }
    }
  }

  // Sign. A non-base64 / otherwise invalid legacy secret makes the
  // standardwebhooks library throw on construction or sign — classify permanent
  // (fail-closed) so the worker records a DLQ row instead of crashing.
  let signed: ReturnType<typeof signOutbound>;
  try {
    signed = signOutbound(req.secret, req.messageId, new Date(), req.payload);
  } catch (err) {
    return {
      kind: "permanent",
      error: `outbound signing failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Signed headers + Content-Type applied LAST so extraHeaders can never
  // override them (the reserved-name guard above already rejects attempts; this
  // ordering is the defense-in-depth backstop).
  const headers: Record<string, string> = {
    ...(req.extraHeaders ?? {}),
    "Content-Type": "application/json",
    ...signed.headers,
  };

  let response: Response;
  try {
    response = await fetch(req.url, {
      method: "POST",
      headers,
      body: signed.body,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error, DNS failure, connection reset, or AbortSignal timeout —
    // all transient. Retry.
    return {
      kind: "retryable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    return { kind: "delivered", status };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: "retryable", status };
  }
  // Any other 4xx (and the rare <200) is a permanent client/contract error.
  return { kind: "permanent", status };
}
