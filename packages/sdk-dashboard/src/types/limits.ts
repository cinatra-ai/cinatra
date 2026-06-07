/**
 * Caps enforced by the dashboards query endpoint per REQUIREMENTS SEM-05.
 * Centralized so the endpoint AND any future client-side validators read
 * the same numbers.
 */
export const QUERY_ENDPOINT_LIMITS = {
  /** Max request body bytes (POST /load). */
  maxBodyBytes: 100_000,
  /** Max combined count of measures + dimensions in a single query. */
  maxQueryComplexity: 20,
  /** Server-side cap on requested rows. Query.limit is clamped to this. */
  maxRows: 5_000,
  /** Hard request-handling deadline in milliseconds. */
  timeoutMs: 30_000,
} as const;

export type QueryEndpointLimits = typeof QUERY_ENDPOINT_LIMITS;
