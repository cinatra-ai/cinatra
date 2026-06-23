// Standard-Webhooks OUTBOUND delivery types (cinatra#341).
//
// The outbound primitive (`deliverOutbound`, outbound.ts) signs via the #340
// `signOutbound` and performs the HTTP POST, returning a discriminated result
// the host's BullMQ scheduler uses to decide retry / DLQ. These types are pure
// (no host imports, no `server-only`) so the lib stays the single signing +
// classification authority and the host owns scheduling/DLQ.

/** A request to deliver one signed outbound webhook. */
export interface OutboundDeliveryRequest {
  /** The absolute target URL the signed payload is POSTed to. */
  readonly url: string;
  /**
   * The Standard-Webhooks secret material. Passed straight into `signOutbound`
   * (the library base64-decodes a `whsec_`-prefixed or raw-base64 secret). A
   * non-decodable legacy secret makes signing throw — `deliverOutbound`
   * catches that and classifies `permanent` (fail-closed; never crashes the
   * worker).
   */
  readonly secret: string;
  /**
   * The Standard-Webhooks `webhook-id` AND the receiver idempotency key. STABLE
   * across retries (the host re-uses the same messageId for every attempt of a
   * given delivery) so a receiver dedupes replays.
   */
  readonly messageId: string;
  /** The JSON-serializable payload. */
  readonly payload: unknown;
  /**
   * Extra request headers (e.g. `X-Cinatra-Assistant-Id`). The signed headers
   * (`webhook-id`/`webhook-timestamp`/`webhook-signature`) and `Content-Type`
   * are applied LAST and these can never override them; supplying a reserved
   * name (case-insensitive) is rejected (classified `permanent`).
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** Tuning knobs for a single delivery attempt. */
export interface OutboundDeliveryOptions {
  /** Per-attempt request timeout. Default 10_000ms. */
  readonly timeoutMs?: number;
}

/**
 * The discriminated outcome of one delivery attempt. The host scheduler maps:
 *   delivered → return (done)
 *   retryable → throw (consume a BullMQ retry attempt; DLQ on last attempt)
 *   permanent → record DLQ + return (no retry)
 */
export type OutboundDeliveryResult =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "retryable"; readonly status?: number; readonly error?: string }
  | { readonly kind: "permanent"; readonly status?: number; readonly error?: string };
