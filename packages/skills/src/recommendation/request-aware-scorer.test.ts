/**
 * cinatra#2041 (epic #2037 S3) — request-aware scorer (AC-1): deterministic
 * scoring + run-intent feature citation. Pure, DB-free.
 */
import { describe, it, expect } from "vitest";

import {
  scoreSkillRecommendations,
  tokenizeIntent,
  DEFAULT_SCORER_WEIGHTS,
  type RecommendationCandidate,
} from "./request-aware-scorer";

function cand(over: Partial<RecommendationCandidate>): RecommendationCandidate {
  return {
    skillId: "s1",
    skillRevisionId: "s1@rev1",
    name: "Skill One",
    description: "",
    ...over,
  };
}

describe("tokenizeIntent", () => {
  it("lowercases, splits on non-alphanumeric, drops stopwords + short tokens, sorts + dedups", () => {
    // "about"/"the"/"a" are stopwords → dropped.
    expect(tokenizeIntent("Draft a WordPress blog post about the launch")).toEqual([
      "blog",
      "draft",
      "launch",
      "post",
      "wordpress",
    ]);
  });
  it("returns [] for empty/undefined", () => {
    expect(tokenizeIntent(undefined)).toEqual([]);
    expect(tokenizeIntent("")).toEqual([]);
    expect(tokenizeIntent("a to of")).toEqual([]); // all short/stopwords
  });
});

describe("determinism (AC-1)", () => {
  it("identical inputs yield byte-identical output", () => {
    const input = {
      intent: { promptText: "write a blog post" },
      candidates: [
        cand({ skillId: "a", name: "Blog writing", description: "write a blog post" }),
        cand({ skillId: "b", name: "SEO", description: "search engine optimization" }),
      ],
    };
    expect(scoreSkillRecommendations(input)).toEqual(scoreSkillRecommendations(input));
  });

  it("ranks by score desc, ties broken by skillId asc", () => {
    // Two candidates with identical (empty) intent match + no base → equal score.
    const out = scoreSkillRecommendations({
      intent: {},
      candidates: [cand({ skillId: "z" }), cand({ skillId: "a" })],
    });
    expect(out.map((r) => r.skillId)).toEqual(["a", "z"]);
    expect(out.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("tie-break is CODE-UNIT order (locale-independent), not localeCompare", () => {
    // "Z" (U+005A) sorts before "a" (U+0061) in code-unit order; a locale-aware
    // compare (e.g. en) would flip them. Pinning code-unit order keeps ties
    // reproducible across runtime locales (AC-1).
    const out = scoreSkillRecommendations({
      intent: {},
      candidates: [cand({ skillId: "a" }), cand({ skillId: "Z" })],
    });
    expect(out.map((r) => r.skillId)).toEqual(["Z", "a"]);
  });
});

describe("feature citation (AC-1)", () => {
  it("cites the base-match signal", () => {
    const [row] = scoreSkillRecommendations({
      intent: {},
      candidates: [cand({ baseMatchScore: 0.8 })],
    });
    expect(row.scoredFeatures).toContainEqual({
      kind: "base_match",
      detail: "score=0.8",
      contribution: DEFAULT_SCORER_WEIGHTS.base * 0.8,
    });
    expect(row.score).toBeCloseTo(0.4, 5);
  });

  it("cites each matched run-intent token", () => {
    const [row] = scoreSkillRecommendations({
      intent: { promptText: "wordpress blog launch" },
      candidates: [
        cand({ name: "WordPress publisher", description: "publish a blog to wordpress" }),
      ],
    });
    const intentFeatures = row.scoredFeatures.filter((f) => f.kind === "intent_token");
    expect(intentFeatures.map((f) => f.detail).sort()).toEqual(["blog", "wordpress"]);
  });

  it("cites a declared-produced-type hit and a target-artifact-kind hit", () => {
    const [row] = scoreSkillRecommendations({
      intent: {
        declaredProducedTypes: ["wordpress:post"],
        targetArtifactKind: "document",
      },
      candidates: [
        cand({ name: "WordPress document helper", description: "produce a wordpress post document" }),
      ],
    });
    const kinds = row.scoredFeatures.map((f) => f.kind);
    expect(kinds).toContain("produced_type");
    expect(kinds).toContain("artifact_kind");
  });

  it("only recommends candidates at/above the threshold", () => {
    const out = scoreSkillRecommendations({
      intent: { promptText: "blog" },
      candidates: [
        cand({ skillId: "hit", name: "blog writer", baseMatchScore: 0.9 }),
        cand({ skillId: "miss", name: "unrelated tax filing", baseMatchScore: null }),
      ],
    });
    const hit = out.find((r) => r.skillId === "hit")!;
    const miss = out.find((r) => r.skillId === "miss")!;
    expect(hit.recommended).toBe(true);
    expect(miss.recommended).toBe(false);
    expect(miss.score).toBe(0);
  });
});

describe("intent-token cap", () => {
  it("caps the total intent-token contribution", () => {
    // Many hits — raw would exceed the cap; the summed intent contribution is
    // clamped to intentTokenCap.
    const promptText = "alpha bravo charlie delta echo foxtrot golf hotel india";
    const [row] = scoreSkillRecommendations({
      intent: { promptText },
      candidates: [cand({ description: promptText })],
    });
    const intentTotal = row.scoredFeatures
      .filter((f) => f.kind === "intent_token")
      .reduce((a, f) => a + f.contribution, 0);
    expect(intentTotal).toBeLessThanOrEqual(DEFAULT_SCORER_WEIGHTS.intentTokenCap + 1e-6);
  });
});

describe("score is bounded to [0,1]", () => {
  it("never exceeds 1 even with base + many features", () => {
    const [row] = scoreSkillRecommendations({
      intent: {
        promptText: "wordpress blog launch content marketing campaign",
        declaredProducedTypes: ["wordpress"],
        targetArtifactKind: "wordpress",
      },
      candidates: [
        cand({
          name: "wordpress blog launch content marketing campaign",
          description: "wordpress blog launch content marketing campaign",
          baseMatchScore: 1,
        }),
      ],
    });
    expect(row.score).toBeLessThanOrEqual(1);
    expect(row.score).toBeGreaterThan(0);
  });
});
