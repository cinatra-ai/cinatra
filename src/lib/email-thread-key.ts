// cinatra#1456 — the ONE canonical derivation of the standardized email thread
// correlation key. Leaf module (no imports) so the WRITER
// (register-email-providers.ts, sent-email + received-reply) and the READER
// (email-correlation-queries.ts, the query seam) share a single source of truth
// and can never drift.
//
// The thread identity is the pair (connectorId, providerThreadId), rendered as
// "<connectorId>:<providerThreadId>". It is a DERIVED correlation key, never an
// artifact id — scoping by connectorId keeps two providers' identical native
// thread ids in distinct buckets.

/**
 * Derive the standardized thread correlation key, or `undefined` when the
 * provider surfaced no usable thread id (a bare send/reply still persists,
 * simply uncorrelated to a thread). Trims both inputs; an empty
 * providerThreadId yields undefined.
 */
export function deriveThreadId(
  connectorId: string,
  providerThreadId: string | null | undefined,
): string | undefined {
  const pid = typeof providerThreadId === "string" ? providerThreadId.trim() : "";
  if (pid === "") return undefined;
  return `${connectorId}:${pid}`;
}
