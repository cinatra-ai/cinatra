import { describe, it, expect } from "vitest";
import {
  RECOMMENDATION_ORDERING_VERSION,
  buildRecommendationTruncation,
  orderRankAuthoritative,
  type RankAuthoritativeRow,
} from "./request-aware-scorer";

// ---------------------------------------------------------------------------
// cinatra#2815 S3 part (4): RecommendationOrderingV1 — the BOUND ordering the
// persisted rows carry. The fixtures pin the COMPLETE ordered boundary, not
// just the version label.
// ---------------------------------------------------------------------------

const row = (skillId: string, score: number, rank: number): RankAuthoritativeRow => ({
  skillId,
  score,
  rank,
});

describe("RecommendationOrderingV1", () => {
  it("pins the literal orderingVersion value", () => {
    expect(RECOMMENDATION_ORDERING_VERSION).toBe("recommendation-ordering-v1");
  });

  it("the authoritative ordered input is the scorer's rank, ascending", () => {
    const ordered = orderRankAuthoritative([
      row("c", 0.1, 3),
      row("a", 0.9, 1),
      row("b", 0.5, 2),
    ]);
    expect(ordered.map((r) => r.skillId)).toEqual(["a", "b", "c"]);
    expect(ordered.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("ties break by score descending, then skillId ascending in CODE-UNIT order", () => {
    // Equal ranks can only reach here from a caller that did not rank; the
    // ordering must still be total, and the tie-break must be the scorer's own.
    const ordered = orderRankAuthoritative([
      row("é-skill", 0.5, 1),
      row("Z-skill", 0.5, 1),
      row("a-skill", 0.5, 1),
      row("b-skill", 0.7, 1),
    ]);
    // Higher score first; then code-unit order — "Z" (0x5A) < "a" (0x61) <
    // "é" (0xE9). A locale-aware compare would sort these differently.
    expect(ordered.map((r) => r.skillId)).toEqual([
      "b-skill",
      "Z-skill",
      "a-skill",
      "é-skill",
    ]);
  });

  it("is total and stable: ordering an ordered list is a no-op", () => {
    const input = [row("a", 0.9, 1), row("b", 0.5, 2), row("c", 0.1, 3)];
    expect(orderRankAuthoritative(orderRankAuthoritative(input))).toEqual(
      orderRankAuthoritative(input),
    );
  });

  it("truncation metadata counts the ELIGIBLE pool, and the cut is AFTER eligibility", () => {
    // 60 eligible candidates, a cap of 50: the pool count is the eligible
    // count BEFORE the cut, and 10 rows were truncated away.
    const meta = buildRecommendationTruncation({ eligibleCount: 60, keptCount: 50 });
    expect(meta).toEqual({
      candidatePoolCount: 60,
      truncatedCount: 10,
      orderingVersion: "recommendation-ordering-v1",
    });
  });

  it("an untruncated pool reports zero truncated, never a negative count", () => {
    expect(buildRecommendationTruncation({ eligibleCount: 7, keptCount: 7 })).toEqual({
      candidatePoolCount: 7,
      truncatedCount: 0,
      orderingVersion: "recommendation-ordering-v1",
    });
    // keptCount can never exceed the pool, but a caller that miscounts must not
    // produce a negative truncation — telemetry never marks unseen candidates.
    expect(
      buildRecommendationTruncation({ eligibleCount: 3, keptCount: 5 }).truncatedCount,
    ).toBe(0);
  });
});
