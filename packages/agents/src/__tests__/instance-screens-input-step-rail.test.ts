/**
 * THE RUN'S FIRST STEP IS A STEP — the screen's half (cinatra#3068).
 *
 * The run page drew its first moment — the agent's own input form — inside a
 * step-less "Agentic Run Progress" panel, with no step list beside it, while
 * every later moment reads as a step: an entry in the rail, the step's own
 * screen in the detail column. This suite pins the screen's part of the fix
 * without a DB, a session or a Next.js render:
 *
 *   • the input steps head the rail, ahead of the recommendation and the
 *     schedule, so the rail exists from the run's FIRST render;
 *   • the run detail OPENS on the input step the run is standing at;
 *   • the two run panels are told the rail carries that step, so neither of
 *     them draws the step-less panel over the form.
 *
 * The DOM halves are `agentic-run-panel.input-step-in-rail.test.tsx` and
 * `orchestrator-stepper-panel.input-step-in-rail.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-input-step-rail.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runDetailInitialStep } from "../instance-screens";
import { buildRunInputSteps } from "../run-input-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import {
  isRunSurfaceStepSelectable,
  resolveRunSurfaceSelection,
} from "../run-surface-rail-step";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/** A run parked on the blog draft writer's own Idea form. */
function awaitingIdea() {
  return buildRunInputSteps({
    required: ["idea"],
    properties: { idea: { title: "Idea" } },
    inputParams: {},
    atInputMoment: true,
  });
}

describe("runDetailInitialStep — the run detail opens on the input step", () => {
  it("opens on the input step the run is standing at, ahead of every step but the run's first gate", () => {
    // ORDER CORRECTED BY cinatra#3047 FIX LEG 8. This case asserted "input:0"
    // over a HELD Skills question, on the strength of a sentence in
    // cinatra#3068's own issue rather than a drawn one. The ratified drawing
    // says the opposite in the section that governs this rail: the Skills
    // question "is the run's first gate — the first entry on the step rail",
    // "ahead of the work steps it would authorize", and it carves out no
    // exception for an input form — it names none anywhere. So a held Skills
    // question opens first, and the form opens the moment it is not held.
    expect(
      runDetailInitialStep({
        openInputStepKey: "input:0",
        hasRecommendationStep: true,
        recommendationHeld: true,
        hasScheduleStep: true,
        hasExecution: false,
      }),
    ).toBe("recommendation");
    expect(
      runDetailInitialStep({
        openInputStepKey: "input:0",
        hasRecommendationStep: true,
        recommendationHeld: false,
        hasScheduleStep: true,
        hasExecution: false,
      }),
    ).toBe("input:0");
  });

  it("leaves every OTHER moment exactly as it was — no open input step, no change", () => {
    // The whole S9d/S9f ladder, unchanged, with the new input clause silent.
    expect(
      runDetailInitialStep({
        openInputStepKey: null,
        hasRecommendationStep: true,
        recommendationHeld: true,
        hasScheduleStep: false,
        hasExecution: false,
      }),
    ).toBe("recommendation");
    expect(
      runDetailInitialStep({
        openInputStepKey: null,
        hasRecommendationStep: false,
        recommendationHeld: false,
        hasScheduleStep: true,
        hasExecution: false,
      }),
    ).toBe("schedule");
    expect(
      runDetailInitialStep({
        openInputStepKey: null,
        hasRecommendationStep: false,
        recommendationHeld: false,
        hasScheduleStep: true,
        hasExecution: true,
      }),
    ).toBe("detail");
  });
});

describe("buildRunInputRailSteps — the input form gets the rail's own step row", () => {
  it("draws the step as the rail's FIRST entry, numbered 1 and openable", () => {
    const railSteps = buildRunInputRailSteps(awaitingIdea(), "the run detail");

    expect(railSteps).toHaveLength(1);
    expect(railSteps[0].key).toBe("input:0");
    // No surface of its own: the form is drawn by the run panel in the detail
    // column, so the step falls back to the run detail the screen composed —
    // the same mechanic the settled recommendation step uses.
    expect(railSteps[0].surface).toBeNull();
    expect(railSteps[0].reached).toBe(true);
    expect(railSteps[0].row).not.toBeNull();
  });

  it("closes a form the run has not reached yet, so no row opens an empty column", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: {},
      atInputMoment: true,
    });
    const railSteps = buildRunInputRailSteps(steps, "the run detail");

    expect(railSteps.map((s) => s.reached)).toEqual([true, false]);
  });

  it("numbers the rows from the offset the caller gives it", () => {
    const railSteps = buildRunInputRailSteps(awaitingIdea(), "the run detail", 2);
    expect(railSteps).toHaveLength(1);
    // The row itself carries the numeral; the offset is what the caller read.
    expect(railSteps[0].key).toBe("input:0");
  });
});

describe("the screen's JSX composes the input step and retires the step-less panel", () => {
  it("puts the input steps on the rail, beneath the run's first gate", () => {
    // ORDER CORRECTED BY cinatra#3047 FIX LEG 8, for the reason given above:
    // the drawing puts the Skills entry at the head of the rail and names no
    // input step anywhere, so there is no drawn exception to weigh against it.
    // What this case still pins is that the input steps ARE on the rail and
    // that the screen builds them there — only their place has moved.
    expect(SCREEN_SRC).toContain("buildRunInputRailSteps");
    const inputPush = SCREEN_SRC.indexOf("railSteps.push(...buildRunInputRailSteps(");
    const recommendationPush = SCREEN_SRC.indexOf('key: "recommendation",');
    expect(inputPush).toBeGreaterThan(-1);
    expect(recommendationPush).toBeGreaterThan(-1);
    expect(recommendationPush).toBeLessThan(inputPush);
  });

  it("tells BOTH run panels that the rail carries the input step", () => {
    // Neither panel may draw the step-less "Agentic Run Progress" section over
    // a form the rail already names.
    //
    // AND THE FACT THEY ARE TOLD IS THAT THE STEP IS OPEN (cinatra#3068 fix leg
    // 2). The rail now keeps the ANSWERED form too, as read-only history, so
    // "the rail carries an input row" and "this panel is drawing that form"
    // stopped being the same fact — and a run that has moved on must keep the
    // progress panel, and its status badge, that it had.
    expect(SCREEN_SRC).toContain("inputStepInRail={inputStepIsOpen}");
    expect(
      SCREEN_SRC.split("inputStepInRail={inputStepIsOpen}").length - 1,
    ).toBe(2);
  });

  it("opens the run detail on the step the input model named", () => {
    // The CALL SITE, not the identifier: an import or a comment mentioning the
    // name would satisfy a bare substring and prove nothing about the wiring.
    expect(SCREEN_SRC).toMatch(
      /runDetailInitialStep\(\{\s*\n\s*openInputStepKey,/,
    );
  });

  it("builds the steps from the RESOLVED schema, the one the setup loop walks", () => {
    // A stored `input_schema: {}` is resolved from the installed agent's OAS at
    // execution time. Reading `template.inputSchema` here would name no input
    // step for exactly the agents whose form the loop still asks — the original
    // defect, surviving the fix (cinatra#3068 convergence).
    expect(SCREEN_SRC).toContain("resolveTemplateInputSchema(template)");
    expect(SCREEN_SRC).toMatch(
      /buildRunInputSteps\(\{\s*\n\s*required: resolvedInputSchema\.required,\s*\n\s*properties: resolvedInputSchema\.properties,/,
    );
  });

  it("carries the steps only while the run is AT its input, or in the handoff", () => {
    // `runCarriesInputSteps`, never `runOwesInputStep` alone: a failed or
    // cancelled run with an unanswered input is not an input moment, and
    // retiring the panel heading there would take its status badge with it.
    //
    // AND THE THIRD ARGUMENT IS THE DISPATCH HANDOFF (cinatra#3184 fix leg 4):
    // the second or two between the skills question just answered and the
    // question the run is walking to, in which the run has answered no form and
    // is asked none. The page is rendered at exactly that moment, so without it
    // the run's own next step left the rail the drawing keeps it on.
    expect(SCREEN_SRC).toMatch(
      /const inputStepsInRail = runCarriesInputSteps\(\s*\n\s*runInputSteps,\s*\n\s*atInputMoment,\s*\n\s*runBetweenSetupQuestions,\s*\n\s*\);/,
    );
  });
});

describe("only the OPEN input form opens (cinatra#3068 convergence)", () => {
  /** A run asking its SECOND form, with the first already answered. */
  function askingAudience() {
    return buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: { idea: { title: "human purpose" } },
      atInputMoment: true,
    });
  }

  it("gives the ANSWERED form its own screen, so it never shows the live one", () => {
    // Every input step falls back to the ONE run detail, and that detail holds
    // the form the run is asking right now. So a settled "Idea" row that fell
    // back would select Idea and display the live Audience question — the
    // rail's one contract, that the selected step shows THAT step's screen,
    // broken. The first leg answered that by closing the settled row; the
    // ratified drawing answers it the other way — "A resolved gate opens
    // read-only: what was decided" — so the row keeps its place AND its own
    // read-only screen, and the fallback is never what it opens.
    const railSteps = buildRunInputRailSteps(askingAudience(), "the run detail");

    expect(railSteps.map((step) => step.key)).toEqual(["input:0", "input:1"]);
    expect(railSteps[0].settled).toBe(true);
    expect(railSteps[0].surface).not.toBeNull();
    expect(railSteps[0].selectable).toBe(true);
    expect(isRunSurfaceStepSelectable(railSteps[0], "the run detail")).toBe(true);
    // And the frame opens exactly the step that was asked for.
    expect(
      resolveRunSurfaceSelection(railSteps, "the run detail", "input:0"),
    ).toBe("input:0");
  });

  it("keeps the form the run IS asking openable, on the run detail's fallback", () => {
    const railSteps = buildRunInputRailSteps(askingAudience(), "the run detail");

    expect(railSteps[1].selectable).toBe(true);
    expect(railSteps[1].surface).toBeNull();
    expect(isRunSurfaceStepSelectable(railSteps[1], "the run detail")).toBe(true);
    expect(
      resolveRunSurfaceSelection(railSteps, "the run detail", "input:1"),
    ).toBe("input:1");
  });

  it("closes a form the run has not reached yet", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: {},
      atInputMoment: true,
    });
    const railSteps = buildRunInputRailSteps(steps, "the run detail");

    expect(isRunSurfaceStepSelectable(railSteps[0], "the run detail")).toBe(true);
    expect(isRunSurfaceStepSelectable(railSteps[1], "the run detail")).toBe(false);
  });
});
