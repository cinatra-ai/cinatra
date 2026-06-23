// Public type surface for the reusable inbound-webhook facility (cinatra#340).
//
// A connector OPTS IN to receiving webhooks by declaring `cinatra.webhooks` in
// its package.json (collected fail-closed by the manifest generator) and
// shipping a handler module exporting the named `factory`. The host owns the
// generic route, the secret store, and the idempotency ledger; the connector
// owns ONLY the per-hook business logic that turns a verified payload into a
// {@link WebhookHandlerOutcome}. The host never imports a connector package and
// never branches on vendor/slug — it dispatches through the generated registry.

/**
 * A successfully VERIFIED inbound webhook, handed to the connector's handler.
 *
 * Every identity field here is host-derived from the verified request — the
 * route resolves `siteId` from the server-issued opaque `bindingId`, NEVER from
 * the request payload (a payload-trusted site identity is a tenant-confusion
 * vector). `payload` is the parsed JSON body; handlers re-validate it with
 * their OWN schema (the verify step authenticates the bytes, it does not shape
 * the payload).
 */
export interface VerifiedWebhook {
  /** Vendor segment (npm scope) the binding was minted for. */
  readonly vendor: string;
  /** Slug segment (npm package name) the binding was minted for. */
  readonly slug: string;
  /** Declared hook id (kebab-case) the binding was minted for. */
  readonly hook: string;
  /** Server-issued opaque binding id the request arrived on. */
  readonly bindingId: string;
  /** Connected-site identity, resolved from the binding (NOT the payload). */
  readonly siteId: string;
  /** Standard-Webhooks `webhook-id` — the idempotency key for this message. */
  readonly messageId: string;
  /** Standard-Webhooks `webhook-timestamp`, as a Date. */
  readonly timestamp: Date;
  /** The exact raw request bytes that were signature-verified. */
  readonly rawBody: Buffer;
  /** The parsed JSON payload (handlers re-validate with their own schema). */
  readonly payload: unknown;
}

/**
 * Least-privilege context handed to a webhook handler. Host services are
 * injected by the route at dispatch; the package keeps this minimal and
 * additive so #341/#343 can widen it without breaking handler signatures.
 */
export interface WebhookContext {
  /** The verified inbound webhook. */
  readonly webhook: VerifiedWebhook;
  /**
   * A scoped logger. Handlers MUST NOT log secret material or full payloads;
   * the host passes a logger that the route can later redact/route centrally.
   */
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The business outcome a handler returns. The host normalizes this to HTTP and
 * to the idempotency-ledger finalize verdict:
 *   - `accepted` — processed; ledger → done; HTTP 200.
 *   - `ignored`  — intentionally not actioned (e.g. an event the connector does
 *                  not care about), but NOT an error; ledger → done; HTTP 200.
 *   - `retryable`— a transient failure; the sender SHOULD retry; ledger →
 *                  failed (so a retry re-claims); HTTP 503.
 *   - `rejected` — the request is well-formed + authentic but semantically
 *                  refused (e.g. a disabled feature); ledger → done (a retry
 *                  would be refused identically); HTTP 204 by default, or the
 *                  manifest-declared `rejectStatus` (opt-in 4xx).
 */
export type WebhookHandlerOutcomeKind = "accepted" | "ignored" | "retryable" | "rejected";

export interface WebhookHandlerOutcome {
  readonly outcome: WebhookHandlerOutcomeKind;
  /** Optional structured detail (NEVER secret material) for logs/telemetry. */
  readonly detail?: Record<string, unknown>;
}

/** A connector's per-hook handler. */
export type WebhookHandler = (ctx: WebhookContext) => Promise<WebhookHandlerOutcome>;

/**
 * The named export each declared hook's handler module must provide. The
 * generator records the `factory` name next to a literal dynamic-import loader
 * (Turbopack-safe) and asserts at generation time that the export is a
 * function; the host builds the handler from `{ load, factory }` fail-loud.
 */
export type WebhookHandlerFactory = () => WebhookHandler;
