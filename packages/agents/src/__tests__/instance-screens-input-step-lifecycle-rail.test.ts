/**
 * THE RAIL IS THE WHOLE LIFECYCLE, AND THE STEP IS NAMED — the screen's half
 * (cinatra#3068, fix leg 2).
 *
 * Three readings the graded pictures refused, all of them the screen's:
 *
 *   • THE STEPS STILL TO COME. At the input moment the rail drew ONE row with
 *     nothing beneath it. The drawing puts the run's later steps below the
 *     highlighted one — "so the rail is the run's whole lifecycle at a glance,
 *     not just its live tip" — so Schedule, Recommendation and Review are drawn
 *     as steps the run has not reached.
 *   • THE ANSWERED STEP KEEPS ITS PLACE. Once the input was given the entry
 *     vanished and the rail renumbered from Schedule. It stays, settled, and
 *     the steps beneath it renumber around it.
 *   • THE YOU-ARE-HERE ANCHOR. The page header named the run and stopped; the
 *     schedule step is named there ("... > Schedule") and the input step was
 *     not. It is named now, through the one crumb channel.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-input-step-lifecycle-rail.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { buildRunInputSteps } from "../run-input-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/** The screen's own two halves, sliced the way the sibling suite slices them. */
const SETUP_SCREEN = SCREEN_SRC.slice(
  SCREEN_SRC.indexOf("export async function SetupScreen"),
  SCREEN_SRC.indexOf("export async function PermissionsScreen"),
);
const TRIGGER_SCREEN = SCREEN_SRC.slice(
  SCREEN_SRC.indexOf("export async function TriggerScreen"),
);

describe("the rail draws the steps still to come below the highlighted step", () => {
  it("names Schedule, Recommendation and Review as the steps the run has not reached", () => {
    expect(SETUP_SCREEN).toContain("upcomingRailStepKeys");
    expect(SETUP_SCREEN).toMatch(
      /const UPCOMING_RUN_RAIL_STEPS[\s\S]{0,120}"schedule"[\s\S]{0,40}"recommendation"[\s\S]{0,40}"review"/,
    );
  });

  it("draws them only for a step the run is standing at, and never twice", () => {
    // A key the rail already drew — a live recommendation hold, an armed
    // schedule — is not drawn a second time as something still to come.
    expect(SETUP_SCREEN).toContain(
      "const drawnRailStepKeys = new Set(railSteps.map((step) => step.key));",
    );
    expect(SETUP_SCREEN).toContain("if (inputStepIsOpen)");
  });

  it("numbers the upcoming rows from the rows already above them", () => {
    const rows = buildSetupRailSteps(
      [
        { key: "schedule", reached: false, settled: false, surface: null },
        { key: "recommendation", reached: false, settled: false, surface: null },
        { key: "review", reached: false, settled: false, surface: null },
      ],
      1,
    );
    expect(rows.map((r) => r.key)).toEqual([
      "schedule",
      "recommendation",
      "review",
    ]);
    // Not reached, so none of them opens an empty column.
    expect(rows.map((r) => r.reached)).toEqual([false, false, false]);
  });
});

describe("the answered first step keeps its place, and the rail renumbers", () => {
  it("prepends the run's settled input steps to the schedule screen's own rail", () => {
    expect(TRIGGER_SCREEN).toContain("buildRunInputRailSteps");
    expect(TRIGGER_SCREEN).toContain("runCarriesInputSteps");
    // The three setup steps renumber around however many input rows stand
    // above them.
    expect(TRIGGER_SCREEN).toContain(
      "buildSetupRailSteps(setupSteps, inputRailSteps.length)",
    );
    expect(TRIGGER_SCREEN).toContain(
      "const railSteps: RunSurfaceRailStep[] = [...inputRailSteps, ...setupRailSteps];",
    );
  });

  it("reads the answered forms from the RESOLVED schema, as the run page does", () => {
    expect(TRIGGER_SCREEN).toContain("resolveTemplateInputSchema(template)");
  });

  it("puts the settled entry first and the schedule second", () => {
    const inputRows = buildRunInputRailSteps(
      buildRunInputSteps({
        required: ["idea"],
        properties: { idea: { title: "Idea" } },
        inputParams: { idea: "why migrations are hard" },
        atInputMoment: false,
      }),
      null,
    );
    const setupRows = buildSetupRailSteps(
      [
        { key: "schedule", surface: "the schedule form" },
        { key: "recommendation", reached: false, surface: null },
        { key: "review", reached: false, surface: null },
      ],
      inputRows.length,
    );
    expect([...inputRows, ...setupRows].map((r) => r.key)).toEqual([
      "input:0",
      "schedule",
      "recommendation",
      "review",
    ]);
    expect(inputRows[0].settled).toBe(true);
  });
});

describe("the you-are-here anchor names the input step", () => {
  it("hands the page header the step's own name while the run stands at it", () => {
    expect(SETUP_SCREEN).toContain("stepCrumbLabel={openInputStep?.label ?? null}");
    expect(SETUP_SCREEN).toContain(
      "const openInputStep = runInputSteps.find((step) => step.open) ?? null;",
    );
  });
});

describe("the detail at the input moment is the step's own card and nothing else", () => {
  it("tells the panels the step is OPEN, not merely that the rail carries a row", () => {
    // The rail now carries the answered row as history too, and the panel's
    // heading must retire only while the form is the step being drawn.
    expect(SCREEN_SRC).toContain(
      "const inputStepIsOpen = openInputStepKey !== null;",
    );
    expect(SCREEN_SRC).toContain("inputStepInRail={inputStepIsOpen}");
    expect(SCREEN_SRC.split("inputStepInRail={inputStepIsOpen}").length - 1).toBe(2);
  });
});
