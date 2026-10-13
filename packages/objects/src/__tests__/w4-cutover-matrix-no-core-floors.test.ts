// THE CUTOVER MATRIX NO LONGER REQUIRES A CORE FLOOR (cinatra#3319,
// acceptance 3).
//
// "The cutover matrix no longer requires first-party floors or the generic query
//  escape."
//
// The matrix is the contract every migration wave drives its real dispatch
// through before it deletes a legacy arm. While two of its required outcomes
// named host-owned floors — a first-party viewer under a disabled or uninstalled
// provider, and an explicit `?renderer=generic` escape — a wave could only pass
// it by KEEPING the very core arms this change retires. The matrix has to name
// what the boundary now allows: an extension display, a requires-rebuild
// diagnostic, or the terminal floor.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ARTIFACT_UI_CUTOVER_MATRIX,
  requiredOutcome,
  type CutoverSystem,
} from "../artifact-ui-cutover-matrix";

const SYSTEMS: readonly CutoverSystem[] = ["representation-viewer", "semantic-renderer"];
const SOURCE = readFileSync(
  resolve(__dirname, "..", "artifact-ui-cutover-matrix.ts"),
  "utf8",
);

describe("acceptance 3 — no required outcome is a first-party floor", () => {
  it("no (system, case) pair requires one", () => {
    for (const system of SYSTEMS) {
      for (const c of ARTIFACT_UI_CUTOVER_MATRIX) {
        expect(
          requiredOutcome(system, c.id),
          `${system}/${c.id} still requires a host-owned floor`,
        ).not.toBe("first-party-floor");
      }
    }
  });

  it("a disabled or uninstalled provider requires the terminal floor on BOTH systems", () => {
    for (const system of SYSTEMS) {
      expect(requiredOutcome(system, "disabled")).toBe("generic-floor");
      expect(requiredOutcome(system, "uninstalled")).toBe("generic-floor");
    }
  });

  it("the observable outcome vocabulary carries no first-party floor at all", () => {
    expect(SOURCE).not.toMatch(/"first-party-floor"/);
  });
});

describe("acceptance 3 — no requirement names the generic query escape", () => {
  it("the floor-recovery case is the error boundary, not a query parameter", () => {
    const recovery = ARTIFACT_UI_CUTOVER_MATRIX.find((c) => c.id === "floor-recovery");
    expect(recovery).toBeDefined();
    expect(recovery!.requirement).not.toMatch(/renderer=generic/);
    expect(recovery!.requirement).toMatch(/error boundary/);
  });

  it("and no requirement in the whole matrix names it", () => {
    for (const c of ARTIFACT_UI_CUTOVER_MATRIX) {
      expect(c.requirement).not.toMatch(/renderer=generic/);
    }
  });
});
