/**
 * WHERE THE GATE HEADER SAYS THE STEP SITS (cinatra#3080, PR #3100, fix leg 7,
 * corrected at convergence).
 *
 * Fix leg 7 drew the drawing's naming line — "Outreach agent \u00b7 run rn_8f31\u2026
 * \u00b7 step 4 of 6" — and sourced its step from the LIVE interrupt alone. A run
 * that has resumed and completed carries no interrupt, so the review card a
 * FINISHED run draws lost the step segment on exactly the reading a reviewer
 * arrives at most often: the review opened after the work was produced.
 *
 * The ladder is still on the page — the rail draws it — so the fallback reads
 * the step the rail is showing, bounded by the ladder's length, and a run with
 * no ladder still names no step rather than inventing one.
 */
import { describe, expect, it } from "vitest";

import { gateNamingStep } from "../orchestrator-gate-predicate";

describe("the step segment of the gate header's naming line", () => {
  it("names the parked step while the run is held at it", () => {
    expect(
      gateNamingStep({ ladderLength: 6, currentDisplayIndex: 4, activeStep: 4 }),
    ).toEqual({ index: 4, total: 6 });
  });

  it("still names a step once the run has completed and the interrupt is gone", () => {
    // A completed run's rail points one PAST the last step; the header names
    // the last step of the ladder, never "step 7 of 6".
    expect(
      gateNamingStep({ ladderLength: 6, currentDisplayIndex: null, activeStep: 7 }),
    ).toEqual({ index: 6, total: 6 });
  });

  it("names the step the rail is showing when the run is mid-flight without an interrupt", () => {
    expect(
      gateNamingStep({ ladderLength: 6, currentDisplayIndex: null, activeStep: 3 }),
    ).toEqual({ index: 3, total: 6 });
  });

  it("names NO step when there is no ladder to read", () => {
    expect(
      gateNamingStep({ ladderLength: 0, currentDisplayIndex: null, activeStep: 1 }),
    ).toBeNull();
    expect(
      gateNamingStep({ ladderLength: 0, currentDisplayIndex: 2, activeStep: 2 }),
    ).toBeNull();
  });
});
