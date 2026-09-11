// @vitest-environment jsdom
//
// THE TWO SEAMS WHERE THE RAIL'S NUMERAL RULE AND THE RUN'S FIRST STEP MEET.
//
// The run page carries two rules that were written against each other and now
// stand on the same rail:
//
//   • the Skills entry draws the drawing's own glyph and CONSUMES NO NUMERAL
//     (cinatra#3047), so every row after it counts from the number the reader
//     actually sees rather than from the list's length;
//   • the run's own input form IS a step (cinatra#3068), so rows drawn beneath
//     it continue the rail's series instead of restarting under it.
//
// Each rule has its own suites. NEITHER of them reads the seam, and the seam is
// where a rail can be wrong while both suites stay green: a row can take the
// glyph rule and forget what stands above it, or count what stands above it and
// number a row the drawing draws with no number. Both readings are here.
//
// The second seam is the panel's, and the same shape: the screen answers two
// questions for the run-progress panel — was the skills question decided
// (cinatra#3047), and does the rail carry the run's input step (cinatra#3068) —
// and both answers reach the panel through one watcher. A watcher that forwards
// one and drops the other draws a run page that is wrong in exactly one reading,
// which is the reading nobody photographs.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/rail-numerals-and-panel-answers.test.tsx
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSetupRailSteps } from "../setup-run-surface-steps";

/** The numeral a built row was handed, in the order the rail lists the rows. */
function numeralsOf(steps: ReturnType<typeof buildSetupRailSteps>): (number | null)[] {
  return steps.map((step) => {
    const row = step.row as { props: { displayStep: number | null } };
    return row.props.displayStep;
  });
}

const STEP = { reached: true, settled: false, surface: "x" } as const;

describe("the setup rail's numerals count the WHOLE rail, and still skip the glyph row", () => {
  it("continues the series from the rows already drawn above these", () => {
    // Two input steps stand above (cinatra#3068), so the three rows beneath them
    // read 3, 4, 5 — not 1, 2, 3.
    const steps = buildSetupRailSteps(
      [
        { key: "recommendation", ...STEP },
        { key: "schedule", ...STEP },
        { key: "review", ...STEP },
      ],
      2,
    );
    // The Skills entry takes NO numeral however many rows stand above it.
    expect(numeralsOf(steps)).toEqual([null, 3, 4]);
  });

  it("is the plain series when these three ARE the rail", () => {
    const steps = buildSetupRailSteps(
      [
        { key: "recommendation", ...STEP },
        { key: "schedule", ...STEP },
        { key: "review", ...STEP },
      ],
      0,
    );
    expect(numeralsOf(steps)).toEqual([null, 1, 2]);
  });

  it("offsets a rail with no Skills entry by exactly what stands above it", () => {
    const steps = buildSetupRailSteps(
      [
        { key: "schedule", ...STEP },
        { key: "review", ...STEP },
      ],
      3,
    );
    expect(numeralsOf(steps)).toEqual([4, 5]);
  });
});

describe("the watcher hands the panel BOTH of the screen's answers", () => {
  const WATCHER_SRC = fs.readFileSync(
    path.join(__dirname, "..", "setup-completion-watcher.tsx"),
    "utf-8",
  );

  it("declares both props", () => {
    expect(WATCHER_SRC).toContain("recommendationDecided?: boolean;");
    expect(WATCHER_SRC).toContain("inputStepInRail?: boolean;");
  });

  it("forwards both to the panel, unchanged and with no second read", () => {
    expect(WATCHER_SRC).toContain("recommendationDecided={recommendationDecided}");
    expect(WATCHER_SRC).toContain("inputStepInRail={inputStepInRail}");
  });
});
