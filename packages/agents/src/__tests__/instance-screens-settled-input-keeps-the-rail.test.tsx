// @vitest-environment jsdom
/**
 * THE SETTLED FIRST STEP KEEPS THE WHOLE RAIL (cinatra#3068, fix leg 3).
 *
 * The ratified drawing, in the section that draws the run surface: "A resolved
 * gate stays on the rail as read-only history -- its entry keeps its place",
 * "steps already passed sit above it, steps still to come below", "so the rail
 * is the run own whole lifecycle at a glance, not just its live tip."
 *
 * WHAT WAS MEASURED. On the third graded reading of this branch, the moment a
 * person answered the run first step and opened that settled row, the rail
 * collapsed from four rows to one: Schedule, Recommendation and Review were not
 * drawn at all. Fix leg 2 appended those three "still to come" rows only while
 * the form was still OPEN, so answering it took them away -- the rail became the
 * live tip again, which is the one reading the drawing forbids.
 *
 * WHAT IS PINNED HERE. The rail row SET, drawn through the very functions the
 * screen calls, and read back off the rendered rail the same way a conformance walk reads
 * it: `[data-run-surface-rail-step]`, in order, with the settled row selected.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-settled-input-keeps-the-rail.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  railDrawsUpcomingRunSteps,
  upcomingRunRailStepKeys,
} from "../instance-screens";
import { buildRunInputSteps } from "../run-input-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import { RunSurfaceRail, type RunSurfaceRailStep } from "../run-surface-rail";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

afterEach(() => {
  cleanup();
});

/** The run measured in the record: one form, named `brief`, answered. */
function briefAnswered() {
  return buildRunInputSteps({
    required: ["brief"],
    properties: { brief: { title: "brief" } },
    inputParams: { brief: "A short guide to choosing a coffee grinder" },
    atInputMoment: false,
  });
}

/** The same form, still being asked. */
function briefOpen() {
  return buildRunInputSteps({
    required: ["brief"],
    properties: { brief: { title: "brief" } },
    inputParams: {},
    atInputMoment: true,
  });
}

/**
 * The run page own rail, composed from the same three calls the screen makes.
 * `drawnKeys` are the rows the page real gate steps already put on the rail.
 */
function runPageRail(params: {
  steps: ReturnType<typeof buildRunInputSteps>;
  inputStepIsOpen: boolean;
  inputStepsInRail: boolean;
  hasExecution: boolean;
  gateRows?: RunSurfaceRailStep[];
}): RunSurfaceRailStep[] {
  const railSteps: RunSurfaceRailStep[] = params.inputStepsInRail
    ? buildRunInputRailSteps(params.steps, "the run detail")
    : [];
  railSteps.push(...(params.gateRows ?? []));
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: params.inputStepIsOpen,
      inputStepsInRail: params.inputStepsInRail,
      hasExecution: params.hasExecution,
    }),
    drawnKeys: railSteps.map((step) => step.key),
  });
  railSteps.push(
    ...buildSetupRailSteps(
      upcoming.map((key) => ({ key, reached: false, settled: false, surface: null })),
      railSteps.length,
    ),
  );
  return railSteps;
}

/** The rail as a reader sees it: every row title, in order. */
function railRowTitles(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll("[data-run-surface-rail-step]"),
  ).map((row) => (row.textContent ?? "").replace(/^\d+/, "").trim());
}

describe("the rail is the run whole lifecycle once the first step is settled", () => {
  it("keeps all four rows with the settled step SELECTED, not one row alone", () => {
    const railSteps = runPageRail({
      steps: briefAnswered(),
      inputStepIsOpen: false,
      inputStepsInRail: true,
      hasExecution: false,
    });
    const view = render(
      <RunSurfaceRail steps={railSteps} detail="the run detail" initialSelection="input:0" />,
    );

    expect(railRowTitles(view.container)).toEqual([
      "brief",
      "Schedule",
      "Recommendation",
      "Review",
    ]);
    // Steps already passed sit above; steps still to come below.
    const rows = view.container.querySelectorAll("[data-run-surface-rail-step]");
    expect(rows[0].getAttribute("data-run-surface-rail-settled")).toBe("true");
    expect(rows[0].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-current")).toBe("step");
    for (const row of Array.from(rows).slice(1)) {
      expect(row.getAttribute("data-run-surface-rail-reached")).toBe("false");
    }
  });

  it("draws the SAME four rows while the form is still open, unchanged by this leg", () => {
    const railSteps = runPageRail({
      steps: briefOpen(),
      inputStepIsOpen: true,
      inputStepsInRail: true,
      hasExecution: false,
    });
    const view = render(
      <RunSurfaceRail steps={railSteps} detail="the run detail" initialSelection="input:0" />,
    );

    expect(railRowTitles(view.container)).toEqual([
      "brief",
      "Schedule",
      "Recommendation",
      "Review",
    ]);
  });
});

describe("railDrawsUpcomingRunSteps -- when the still-to-come rows ride", () => {
  it("rides while the form is open, and KEEPS riding once it is answered", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: true,
        inputStepsInRail: true,
        hasExecution: false,
      }),
    ).toBe(true);
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: true,
        hasExecution: false,
      }),
    ).toBe(true);
  });

  it("stops where the run own history starts -- a run that has executed draws none", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: true,
        hasExecution: true,
      }),
    ).toBe(false);
  });

  it("draws none for a run whose rail carries no input step at all", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: false,
        hasExecution: false,
      }),
    ).toBe(false);
  });
});

describe("upcomingRunRailStepKeys -- never twice", () => {
  it("leaves a key the rail already drew the row it has", () => {
    expect(
      upcomingRunRailStepKeys({ drawUpcoming: true, drawnKeys: ["input:0", "schedule"] }),
    ).toEqual(["recommendation", "review"]);
  });

  it("returns nothing when the rows do not ride", () => {
    expect(upcomingRunRailStepKeys({ drawUpcoming: false, drawnKeys: [] })).toEqual([]);
  });
});

describe("the screen JSX composes the rail through those two answers", () => {
  it("gates the still-to-come rows on the predicate, not on the form being open", () => {
    expect(SCREEN_SRC).toMatch(
      /const upcomingRailStepKeys = upcomingRunRailStepKeys\(\{\s*\n\s*drawUpcoming: railDrawsUpcomingRunSteps\(\{/,
    );
    // AND ON THE RUN'S OWN THREE FACTS. Asserting only that the two names are
    // nested would stay green if the screen handed the predicate a constant, or
    // the wrong run's execution reading, so the arguments are pinned too.
    expect(SCREEN_SRC).toMatch(
      /railDrawsUpcomingRunSteps\(\{\s*\n\s*inputStepIsOpen,\s*\n\s*inputStepsInRail,\s*\n\s*hasExecution: runHasExecution,\s*\n\s*\}\),\s*\n\s*drawnKeys: railSteps\.map\(\(step\) => step\.key\),/,
    );
    // The leg-2 gate, which took the rows away the moment the form was answered.
    expect(SCREEN_SRC).not.toContain("if (inputStepIsOpen) {");
  });
});
