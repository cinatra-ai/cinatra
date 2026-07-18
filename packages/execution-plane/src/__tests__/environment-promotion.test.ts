import { describe, expect, it } from "vitest";

import {
  applyPromotion,
  computePromotionCandidates,
  type ObservedAdhocInstall,
} from "../environment/promotion";

const install = (runId: string, packageName: string): ObservedAdhocInstall => ({
  runId,
  manager: "pip",
  packageName,
});

describe("computePromotionCandidates", () => {
  it('surfaces "installed pandoc on 6 of the last 10 runs" style candidates', () => {
    const observations: ObservedAdhocInstall[] = [];
    for (let i = 1; i <= 10; i++) {
      if (i <= 6) observations.push(install(`run-${i}`, "pandoc"));
      else observations.push(install(`run-${i}`, `noise-${i}`));
    }
    const candidates = computePromotionCandidates(observations, {}, { windowRuns: 10 });
    expect(candidates[0]).toEqual({
      manager: "pip",
      packageName: "pandoc",
      runCount: 6,
      windowRuns: 10,
    });
    // Noise below the threshold (1/10) never surfaces.
    expect(candidates.some((c) => c.packageName.startsWith("noise-"))).toBe(false);
  });

  it("only counts the most recent window of DISTINCT runs", () => {
    const observations = [
      install("old-1", "leftpad"),
      install("old-2", "leftpad"),
      install("new-1", "pandoc"),
      install("new-2", "pandoc"),
    ];
    const candidates = computePromotionCandidates(observations, {}, { windowRuns: 2 });
    expect(candidates).toEqual([
      { manager: "pip", packageName: "pandoc", runCount: 2, windowRuns: 2 },
    ]);
  });

  it("never proposes a package the spec already declares (any constraint form)", () => {
    const observations = [install("r1", "pandas"), install("r2", "pandas")];
    const candidates = computePromotionCandidates(
      observations,
      { pip: ["pandas==2.2.1"] },
      { windowRuns: 2 },
    );
    expect(candidates).toEqual([]);
  });

  it("returns [] for no observations", () => {
    expect(computePromotionCandidates([], {})).toEqual([]);
  });
});

describe("applyPromotion", () => {
  it("returns a REVIEWABLE proposal and never mutates the input spec", () => {
    const before = { pip: ["requests"] };
    const proposal = applyPromotion(before, {
      manager: "pip",
      packageName: "pandoc",
      runCount: 6,
      windowRuns: 10,
    });
    expect(before).toEqual({ pip: ["requests"] }); // untouched
    expect(proposal.before).toBe(before);
    expect(proposal.after).toEqual({ pip: ["pandoc", "requests"] });
  });

  it("refuses a candidate that cannot form a valid entry (fail-closed)", () => {
    expect(() =>
      applyPromotion({}, {
        manager: "pip",
        packageName: "evil; rm -rf /",
        runCount: 6,
        windowRuns: 10,
      }),
    ).toThrow(/does not form a\s+valid environment entry/);
  });
});
