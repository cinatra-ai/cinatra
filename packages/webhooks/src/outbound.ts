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

import { fetch as undiciFetch } from "undici";
import { signOutbound } from "./sign";
import {
  assertEgressAllowed,
  buildPinnedAgent,
  EgressBlockedError,
  isEgressBlock,
} from "./egress-guard";
import type {
  OutboundDeliveryRequest,
  OutboundDeliveryOptions,
  OutboundDeliveryResult,
  OutboundTransport,
} from "./outbound-types";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Production transport: undici's own `fetch`, pinned (via the per-attempt
 * `dispatcher`) to the egress-validated address so a connect-time DNS-rebind to
 * an internal IP cannot land. `redirect:"manual"` is honored by undici fetch —
 * a redirect is NOT followed (a 3xx falls through to status classification),
 * closing the "public URL 302s to metadata/RFC1918" hole.
 */
const productionTransport: OutboundTransport = async (url, init) => {
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: init.redirect,
    dispatcher: init.dispatcher as never,
  });
  // We only need the status; drain+discard the body so the socket is released
  // deterministically (an undrained body keeps the connection alive until GC).
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed / no body — ignore */
  }
  return { status: res.status };
};

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
 *   - 3xx (manual redirect)       → permanent (redirects are NOT followed — an
 *                                    open redirect must not chain into an
 *                                    internal address; engineering#370)
 *   - 408 / 425 / 429 / 5xx       → retryable (transient/overload)
 *   - network error / timeout     → retryable
 *   - any other 4xx               → permanent (a client-contract error; retrying
 *                                    the same bytes will keep failing)
 *   - signing throws (bad secret) → permanent (fail-closed; never crash)
 *   - reserved-header collision   → permanent (producer bug)
 *   - egress blocked (SSRF guard) → permanent (internal/denied target; DLQ, no
 *                                    retry storm — engineering#370)
 *
 * SSRF/egress guard (engineering#370): BEFORE sending, the operator-supplied
 * target URL is validated by `assertEgressAllowed` — http/https only, no
 * embedded credentials, no internal host aliases, and every resolved address
 * (literal or DNS) classified against the special-use/private/link-local/ULA/
 * metadata deny ranges. The connection is then PINNED (undici dispatcher) to
 * the validated address so a DNS-rebind at connect time cannot reach an
 * internal IP. A block is `permanent` (no retry).
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

  // SSRF/egress guard (engineering#370): validate scheme/host and resolve+check
  // EVERY address BEFORE sending. A block is permanent (DLQ, no retry storm) —
  // re-POSTing the same bytes at the same internal target will keep failing. A
  // genuine resolver failure (NXDOMAIN/EAI_AGAIN) is NOT a block; it propagates
  // and is classified retryable below.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let pinnedDispatcher: unknown | undefined;
  try {
    const validated = await assertEgressAllowed(req.url, {
      lookup: opts?.egress?.lookup,
    });
    pinnedDispatcher = buildPinnedAgent(validated, timeoutMs);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      return { kind: "permanent", error: err.message };
    }
    // Resolver error (NXDOMAIN / EAI_AGAIN / etc.) — transient, retry.
    return {
      kind: "retryable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const transport: OutboundTransport = opts?.egress?.transport ?? productionTransport;

  let status: number;
  try {
    const result = await transport(req.url, {
      method: "POST",
      headers,
      body: signed.body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      dispatcher: pinnedDispatcher,
    });
    status = result.status;
  } catch (err) {
    // A connect-time DNS-rebind block surfaces as a fetch error whose `cause`
    // chain carries our EgressBlockedError — that is PERMANENT, not a transient
    // network error.
    if (isEgressBlock(err)) {
      return {
        kind: "permanent",
        error: `egress blocked at connect: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Network error, DNS failure, connection reset, or AbortSignal timeout —
    // all transient. Retry.
    return {
      kind: "retryable",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Hard-release the per-attempt agent's sockets (best-effort; never throws).
    // destroy() is immediate (vs close() which awaits in-flight); the response
    // body is already drained above, so nothing in-flight is lost.
    const agent = pinnedDispatcher as { destroy?: () => Promise<void> } | undefined;
    if (agent && typeof agent.destroy === "function") {
      void agent.destroy().catch(() => {});
    }
  }

  if (status >= 200 && status < 300) {
    return { kind: "delivered", status };
  }
  // 3xx is reachable only with redirect:"manual" — we do NOT follow redirects
  // (an open redirect must not chain into an internal address). Treat as a
  // permanent client-contract error.
  if (status >= 300 && status < 400) {
    return { kind: "permanent", status };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: "retryable", status };
  }
  // Any other 4xx (and the rare <200) is a permanent client/contract error.
  return { kind: "permanent", status };
}
