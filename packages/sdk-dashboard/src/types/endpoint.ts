/**
 * Endpoint allowlist for the dashboards query route.
 *
 * `meta` and `load` are Cube.js-compatible: the route serves
 * drizzle-cube/client AND Cinatra's internal `useCubeQuery`. `batch` is
 * the drizzle-cube/client batch coordinator path — used by
 * `useMultiCubeLoadQuery`; it serves as serial-N over `load`.
 *
 * Any segment not in this list returns 404.
 */
export const ALLOWED_ENDPOINTS = ["meta", "load", "batch"] as const;
export type AllowedEndpoint = (typeof ALLOWED_ENDPOINTS)[number];

export function isAllowedEndpoint(s: string): s is AllowedEndpoint {
  return (ALLOWED_ENDPOINTS as readonly string[]).includes(s);
}

/**
 * Cinatra-DTO error response shape. Returned by the endpoint for all 4xx
 * structured rejections (caps violations, allowlist misses, bad input).
 */
export type QueryEndpointError = {
  readonly error: string;
  readonly code:
    | "endpoint_not_allowed"
    | "body_too_large"
    | "body_parse_failed"
    | "query_too_complex"
    | "timeout"
    | "unauthorized"
    | "internal_error"
    | "unsupported_analysis_type"
    | "unsupported_query_feature"
    | "cube_id_required"
    | "cube_id_ambiguous"
    | "batch_too_large"
    // cinatra#660 — runtime-cube serve-gate (CG-5) fail-closed codes.
    | "cube_not_active"
    | "cube_untrusted";
  readonly details?: Readonly<Record<string, unknown>>;
};
// The endpoint clamps Query.limit silently to QUERY_ENDPOINT_LIMITS.maxRows
// rather than rejecting. If a future strict mode wants to reject instead of
// clamp, add a response code for that path and emit it.

/**
 * Maximum number of queries allowed in a single POST /batch call.
 * drizzle-cube's AnalysisBuilder permits up to 5 multi-query slots per
 * portlet by default; 8 leaves headroom for future increases.
 */
export const BATCH_MAX_QUERIES = 8;
