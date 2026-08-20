/**
 * cinatra#2041 (epic #2037 S3) — per-run selection pure core: continuation
 * (AC-3, headless never parks), confirm derivation, delivery resolution (AC-2
 * fallback), efficacy split (AC-6). Pure, DB-free.
 */
import { describe, it, expect } from "vitest";

import {
  decideRecommendationContinuation,
  deriveConfirmedSelection,
  resolveRunSkillDelivery,
  summarizeRecommendationEfficacy,
  SELECTION_SOURCES,
} from "./selection";
import type { RankedRecommendation } from "./request-aware-scorer";

function rec(over: Partial<RankedRecommendation>): RankedRecommendation {
  return {
    skillId: "s1",
    skillRevisionId: "s1@rev1",
    name: "skill-one",
    // The resolved label a surface prints (cinatra#2841) — distinct from the
    // catalog `name`, so a fixture can never make the two look interchangeable.
    displayName: "Skill One",
    score: 0.9,
    rank: 1,
    recommended: true,
    scoredFeatures: [],
    ...over,
  };
}

describe("decideRecommendationContinuation (AC-3)", () => {
  it("did-not-fire → skipped, empty selection, no park", () => {
    const out = decideRecommendationContinuation({
      policyFired: false,
      humanPresent: true,
      recommendations: [rec({})],
    });
    expect(out.mode).toBe("skipped");
    expect(out).not.toHaveProperty("park");
    if (out.mode === "skipped") expect(out.selection).toEqual([]);
  });

  it("fired + human present → await_confirmation (never parks, never auto-writes)", () => {
    const out = decideRecommendationContinuation({
      policyFired: true,
      humanPresent: true,
      recommendations: [rec({})],
    });
    expect(out.mode).toBe("await_confirmation");
  });

  it("fired + headless → auto_applied top-N recommended with the auto source; NEVER parks", () => {
    const recs = [
      rec({ skillId: "a", skillRevisionId: "a@1", recommended: true }),
      rec({ skillId: "b", skillRevisionId: "b@1", recommended: true }),
      rec({ skillId: "c", skillRevisionId: "c@1", recommended: false }),
    ];
    const out = decideRecommendationContinuation({
      policyFired: true,
      humanPresent: false,
      recommendations: recs,
      autoApplyLimit: 5,
    });
    expect(out.mode).toBe("auto_applied");
    if (out.mode === "auto_applied") {
      // Only recommended candidates; c is excluded.
      expect(out.selection.map((s) => s.skillId)).toEqual(["a", "b"]);
      expect(out.selection.every((s) => s.selectionSource === SELECTION_SOURCES.recommendedAutoApplied)).toBe(true);
    }
  });

  it("headless auto-apply respects the limit", () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      rec({ skillId: `s${i}`, skillRevisionId: `s${i}@1`, recommended: true }),
    );
    const out = decideRecommendationContinuation({
      policyFired: true,
      humanPresent: false,
      recommendations: recs,
      autoApplyLimit: 3,
    });
    if (out.mode === "auto_applied") expect(out.selection).toHaveLength(3);
    else throw new Error("expected auto_applied");
  });
});

describe("deriveConfirmedSelection", () => {
  const recs = [
    rec({ skillId: "a", skillRevisionId: "a@rev" }),
    rec({ skillId: "b", skillRevisionId: "b@rev" }),
  ];
  it("stamps confirmed recommendations with recommended_confirmed + the pinned rev", () => {
    const out = deriveConfirmedSelection({ recommendations: recs, confirmedSkillIds: ["a"] });
    expect(out).toEqual([
      { skillId: "a", skillRevisionId: "a@rev", selectionSource: SELECTION_SOURCES.recommendedConfirmed },
    ]);
  });
  it("stamps a forced non-recommended skill as user_forced when a revision is supplied", () => {
    const out = deriveConfirmedSelection({
      recommendations: recs,
      confirmedSkillIds: ["a", "x"],
      forcedRevisions: { x: "x@rev" },
    });
    expect(out.map((s) => [s.skillId, s.selectionSource])).toEqual([
      ["a", SELECTION_SOURCES.recommendedConfirmed],
      ["x", SELECTION_SOURCES.userForced],
    ]);
  });
  it("drops an unknown id with no supplied revision (never guesses)", () => {
    const out = deriveConfirmedSelection({ recommendations: recs, confirmedSkillIds: ["ghost"] });
    expect(out).toEqual([]);
  });
  it("dedups repeated confirmed ids", () => {
    const out = deriveConfirmedSelection({ recommendations: recs, confirmedSkillIds: ["a", "a"] });
    expect(out).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // IN-SET ADJUSTMENT (cinatra#2841) — §V's third settled mark, made reachable
  // -------------------------------------------------------------------------

  it("stamps an IN-SET adjusted skill user_adjusted, on its recommended revision", () => {
    // The defect this closes: the chip row offers exactly the scored set, and
    // every id in that set was stamped `recommended_confirmed` however the
    // reader settled it — so a chip settled through ADJUST read back
    // `Confirmed` and §V's `Adjusted` mark could never appear.
    const out = deriveConfirmedSelection({
      recommendations: recs,
      confirmedSkillIds: ["a", "b"],
      adjustedSkillIds: ["b"],
    });
    expect(out).toEqual([
      { skillId: "a", skillRevisionId: "a@rev", selectionSource: SELECTION_SOURCES.recommendedConfirmed },
      // The revision is untouched — an in-set adjustment relabels how the
      // selection was reached, never WHICH revision the run pins.
      { skillId: "b", skillRevisionId: "b@rev", selectionSource: SELECTION_SOURCES.userAdjusted },
    ]);
  });

  it("leaves a NON-recommended adjusted skill as user_forced — forcing it on IS its adjustment", () => {
    // Re-labelling it would lose the one fact `user_forced` asserts: the scorer
    // did not recommend this skill. Both sources read as §V's `adjusted` mark.
    const out = deriveConfirmedSelection({
      recommendations: recs,
      confirmedSkillIds: ["x"],
      forcedRevisions: { x: "x@rev" },
      adjustedSkillIds: ["x"],
    });
    expect(out).toEqual([
      { skillId: "x", skillRevisionId: "x@rev", selectionSource: SELECTION_SOURCES.userForced },
    ]);
  });

  it("NEGATIVE CONTROL: naming no adjusted skill leaves every confirm recommended_confirmed", () => {
    const out = deriveConfirmedSelection({
      recommendations: recs,
      confirmedSkillIds: ["a", "b"],
      adjustedSkillIds: [],
    });
    expect(out.map((s) => s.selectionSource)).toEqual([
      SELECTION_SOURCES.recommendedConfirmed,
      SELECTION_SOURCES.recommendedConfirmed,
    ]);
  });

  it("an adjusted id that was never confirmed is not selected at all", () => {
    // `adjustedSkillIds` is a LABEL on the kept set, never a way into it.
    const out = deriveConfirmedSelection({
      recommendations: recs,
      confirmedSkillIds: ["a"],
      adjustedSkillIds: ["b"],
    });
    expect(out.map((s) => s.skillId)).toEqual(["a"]);
  });
});

describe("resolveRunSkillDelivery (AC-2)", () => {
  it("a non-empty selected set WINS over the computed assignment (dedup, first-seen order)", () => {
    const out = resolveRunSkillDelivery({
      selectedSet: [{ skillId: "sel1" }, { skillId: "sel2" }, { skillId: "sel1" }],
      computedAssignedIds: ["comp1", "comp2"],
    });
    expect(out.source).toBe("selected_set");
    expect(out.skillIds).toEqual(["sel1", "sel2"]);
  });
  it("an EMPTY set falls back to the computed assignment (unchanged behavior)", () => {
    const out = resolveRunSkillDelivery({ selectedSet: [], computedAssignedIds: ["comp1", "comp2"] });
    expect(out.source).toBe("computed_fallback");
    expect(out.skillIds).toEqual(["comp1", "comp2"]);
  });
});

describe("summarizeRecommendationEfficacy (AC-6)", () => {
  it("splits recommended skills into accepted vs rejected by the final selection", () => {
    const recs = [
      rec({ skillId: "a", recommended: true }),
      rec({ skillId: "b", recommended: true }),
      rec({ skillId: "c", recommended: false }), // not recommended → ignored
    ];
    const out = summarizeRecommendationEfficacy({ recommendations: recs, selectedSkillIds: ["a"] });
    expect(out.accepted).toEqual(["a"]);
    expect(out.rejected).toEqual(["b"]);
  });
});
