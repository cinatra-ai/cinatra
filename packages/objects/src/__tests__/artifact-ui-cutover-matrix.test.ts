import { describe, it, expect } from "vitest";

import {
  ARTIFACT_UI_CUTOVER_MATRIX,
  evaluateArmCutover,
  requiredOutcome,
  type CutoverCaseId,
  type CutoverObservation,
  type CutoverSystem,
} from "../artifact-ui-cutover-matrix";

// A helper that plays a "perfect" migration: every case observes exactly the
// required outcome (and the single-module case reports one module).
function perfectObserve(system: CutoverSystem) {
  return (caseId: CutoverCaseId): CutoverObservation => ({
    outcome: requiredOutcome(system, caseId),
    modulesExecuted: 1,
  });
}

describe("G2 artifact-UI cutover matrix", () => {
  it("enumerates all ten world-states", () => {
    expect(ARTIFACT_UI_CUTOVER_MATRIX.map((c) => c.id)).toEqual([
      "provider-registered",
      "enabled-and-selected",
      "selected-via-correct-registry",
      "precedence",
      "disabled",
      "uninstalled",
      "incompatible",
      "failing",
      "floor-recovery",
      "single-module-executes",
    ]);
  });

  it("required outcomes differ by system for the floor cases (never cross-applied)", () => {
    expect(requiredOutcome("representation-viewer", "disabled")).toBe("first-party-floor");
    expect(requiredOutcome("semantic-renderer", "disabled")).toBe("generic-floor");
    expect(requiredOutcome("representation-viewer", "incompatible")).toBe("requires-rebuild");
    expect(requiredOutcome("representation-viewer", "enabled-and-selected")).toBe("extension");
  });

  it("a perfect migration is ready for both systems", () => {
    for (const system of ["representation-viewer", "semantic-renderer"] as CutoverSystem[]) {
      const report = evaluateArmCutover({ system, arm: "x", observe: perfectObserve(system) });
      expect(report.ready, JSON.stringify(report.unmet)).toBe(true);
      expect(report.unmet).toEqual([]);
    }
  });

  it("a CROSS-APPLIED selection fails (a viewer resolved as a semantic winner)", () => {
    const observe = (caseId: CutoverCaseId): CutoverObservation =>
      caseId === "selected-via-correct-registry"
        ? { outcome: "cross-applied", modulesExecuted: 1 }
        : { outcome: requiredOutcome("representation-viewer", caseId), modulesExecuted: 1 };
    const report = evaluateArmCutover({ system: "representation-viewer", arm: "application/pdf", observe });
    expect(report.ready).toBe(false);
    expect(report.unmet).toContain("selected-via-correct-registry");
  });

  it("the single-module invariant fails when more than one module executes", () => {
    const observe = (caseId: CutoverCaseId): CutoverObservation => ({
      outcome: requiredOutcome("semantic-renderer", caseId),
      modulesExecuted: caseId === "single-module-executes" ? 2 : 1,
    });
    const report = evaluateArmCutover({ system: "semantic-renderer", arm: "@x/y:z", observe });
    expect(report.ready).toBe(false);
    expect(report.unmet).toEqual(["single-module-executes"]);
  });

  it("a probe that throws degrades to a failed (never-ready) case, not a crash", () => {
    const observe = (caseId: CutoverCaseId): CutoverObservation => {
      if (caseId === "failing") throw new Error("boom");
      return { outcome: requiredOutcome("representation-viewer", caseId), modulesExecuted: 1 };
    };
    const report = evaluateArmCutover({ system: "representation-viewer", arm: "application/pdf", observe });
    expect(report.ready).toBe(false);
    expect(report.unmet).toEqual(["failing"]);
    expect(report.cases.find((c) => c.id === "failing")?.detail).toMatch(/probe threw/);
  });

  it("an incomplete migration (missing floor recovery) is NOT ready", () => {
    const observe = (caseId: CutoverCaseId): CutoverObservation =>
      caseId === "floor-recovery"
        ? { outcome: "extension", modulesExecuted: 1 } // wrongly still resolving an extension
        : { outcome: requiredOutcome("representation-viewer", caseId), modulesExecuted: 1 };
    const report = evaluateArmCutover({ system: "representation-viewer", arm: "application/pdf", observe });
    expect(report.ready).toBe(false);
    expect(report.unmet).toEqual(["floor-recovery"]);
  });
});
