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
  it("names Skills, Schedule and Review as the steps the run has not reached", () => {
    expect(SETUP_SCREEN).toContain("upcomingRailStepKeys");
    // THE THREE WORDS MOVED, AND ONLY MOVED (cinatra#3068 fix leg 3): they are a
    // named answer of the screen's own now, so the settled first step keeps them
    // too. `instance-screens-settled-input-keeps-the-rail.test.tsx` reads the
    // rows that come out of it.
    //
    // THEIR ORDER CORRECTED BY cinatra#3047 FIX LEG 8. An upcoming row is drawn
    // where its step will stand, and the ratified drawing stands the Skills
    // entry at the head of the rail — "the first entry on the step rail ...
    // ahead of the work steps it would authorize" — so it heads these too.
    // Listing the schedule first drew the Skills entry third on a run that also
    // carried an input form, which the eighth proof round photographed.
    expect(SCREEN_SRC).toMatch(
      /const UPCOMING_RUN_RAIL_STEP_KEYS[\s\S]{0,120}"recommendation"[\s\S]{0,40}"schedule"[\s\S]{0,40}"review"/,
    );
  });

  it("draws them while the rail carries the run's input step, and never twice", () => {
    // A key the rail already drew — a live recommendation hold, an armed
    // schedule — is not drawn a second time as something still to come. The
    // de-duplication is INSIDE that answer now, so no call site can forget it.
    expect(SCREEN_SRC).toContain("const drawn = new Set(params.drawnKeys);");
    expect(SETUP_SCREEN).toContain("drawnKeys: railSteps.map((step) => step.key),");
    // AND NOT ONLY WHILE THE FORM IS OPEN (fix leg 3). Leg 2's gate took the
    // three rows away the moment the step was answered, so the rail collapsed
    // to the settled row alone — the live tip the drawing forbids.
    expect(SETUP_SCREEN).toContain("drawUpcoming: railDrawsUpcomingRunSteps({");
    expect(SETUP_SCREEN).not.toContain("if (inputStepIsOpen)");
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

describe("the trail names no step (cinatra#3223)", () => {
  it("hands the page header no step crumb: a step is a reading inside the run's route, not a route", () => {
    // The ratified drawing's Breadcrumb section: "'Agents › Agent run › Review'
    // is not a possible breadcrumb". The you-are-here anchor is the rail row.
    expect(SETUP_SCREEN).not.toContain("stepCrumbLabel");
    expect(SETUP_SCREEN).not.toContain("openInputStep?.label");
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
