/**
 * The request-aware recommendation PURE barrel (cinatra#2041, epic #2037 S3).
 *
 * Leaf-safe: re-exports only the pure scorer + selection cores, so the host
 * bridge, the execution worker, client chip-row surfaces, and the MCP primitive
 * all obtain the SAME scoring/selection logic via `@cinatra-ai/skills/
 * recommendation` WITHOUT pulling the side-effectful main `@cinatra-ai/skills`
 * barrel. Keep this import-free of server-only modules.
 */

export * from "./request-aware-scorer";
export * from "./selection";

// RecommendationOrderingV1 — the BOUND ordering a persisted recommendation
// carries (cinatra#2815 S3 part 4).
export {
  RECOMMENDATION_ORDERING_VERSION,
  RECOMMENDATION_POOL_CAP,
  buildRecommendationTruncation,
  orderRankAuthoritative,
  type RankAuthoritativeRow,
  type RecommendationTruncationV1,
} from "./request-aware-scorer";
