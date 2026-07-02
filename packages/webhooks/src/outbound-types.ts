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

/**
 * The minimal transport `deliverOutbound` needs: a `fetch`-shaped function plus
 * an optional per-attempt `dispatcher` (undici) the production transport uses to
 * PIN the connection to the egress-validated address (DNS-rebind defense).
 *
 * The production default uses undici's own `fetch` (it interops with the
 * undici@8 Agent the egress guard builds; Node's global `fetch` does NOT — they
 * bundle different undici majors). Tests inject a fake transport to assert the
 * request without real network/DNS.
 */
export type OutboundTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: "manual";
    dispatcher?: unknown;
  },
) => Promise<{ status: number }>;

/** Injectable DNS resolver seam for the egress guard (see egress-guard.ts). */
export type OutboundEgressLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

/** Tuning knobs for a single delivery attempt. */
export interface OutboundDeliveryOptions {
  /** Per-attempt request timeout. Default 10_000ms. */
  readonly timeoutMs?: number;
  /**
   * Egress-guard seams. `lookup` overrides DNS resolution (default
   * `dns.lookup`); `transport` overrides the HTTP transport (default: undici
   * fetch pinned to the validated address). Both exist for tests ONLY — neither
   * is wired to operator config, so a target can never opt out of the guard.
   */
  readonly egress?: {
    readonly lookup?: OutboundEgressLookup;
    readonly transport?: OutboundTransport;
  };
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
