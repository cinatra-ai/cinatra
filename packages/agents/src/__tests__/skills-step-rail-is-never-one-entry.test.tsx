// @vitest-environment jsdom
/**
 * THE SKILLS STEP NEVER DRAWS A ONE-ENTRY RAIL (cinatra#3184 item 1,
 * convergence round).
 *
 * The ratified drawing, in the section that draws the run surface: the skills
 * question "is the run's first gate -- the first entry on the step rail, where
 * it is named Skills, ahead of the work steps it would authorize", and "steps
 * already passed sit above it, steps still to come below ... so the rail is the
 * run's whole lifecycle at a glance, not just its live tip."
 *
 * WHAT WAS MEASURED WRONG. The ninth graded reading of cinatra#3047 read four
 * rows -- Skills, 1 Setup, 2 Schedule, 3 Review -- on a run that carried an
 * input form, and item 1 was read as satisfied from it. It is satisfied only on
 * THAT run. The still-to-come rows rode on one fact alone: that the rail
 * carried the run's input steps. An agent whose template asks no visible
 * required input carries none, so on a run held at its skills question with no
 * schedule row of its own the whole rail was the gate row -- one entry, the
 * reading `screenDrawsPageRail`'s own comment calls the one the plan does not
 * allow ("a rail holding the gate row alone shows nothing for it to be ahead
 * of").
 *
 * WHAT IS PINNED HERE. The rows ride for the GATE step too, for as long as the
 * run has produced no execution record -- composed through the same functions
 * the screen calls, and read back off the rendered rail the way a conformance
 * walk reads it: `[data-run-surface-rail-step]`, in order.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-rail-is-never-one-entry.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  railDrawsUpcomingRunSteps,
  upcomingRunRailStepKeys,
} from "../instance-screens";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { RunSurfaceRail, type RunSurfaceRailStep } from "../run-surface-rail";
import { runSurfaceStepDrawsGlyph } from "../run-surface-rail-step";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

afterEach(() => {
  cleanup();
});

/**
 * The run page's rail for a run held at its skills question that carries NO
 * input form and no schedule row -- composed from the same three calls the
 * screen makes, with the gate row standing in for the screen's own
 * `recommendation` entry.
 */
function skillsOnlyRail(params: {
  hasExecution: boolean;
  gateRow: RunSurfaceRailStep;
}): RunSurfaceRailStep[] {
  const railSteps: RunSurfaceRailStep[] = [params.gateRow];
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: false,
      inputStepsInRail: false,
      gateStepInRail: true,
      hasExecution: params.hasExecution,
    }),
    drawnKeys: railSteps.map((step) => step.key),
  });
  const asStep = (key: (typeof upcoming)[number]) => ({
    key,
    reached: false,
    settled: false,
    surface: null,
  });
  const head = upcoming.filter((key) => runSurfaceStepDrawsGlyph(key));
  const numbered = upcoming.filter((key) => !runSurfaceStepDrawsGlyph(key));
  if (head.length > 0) {
    railSteps.unshift(...buildSetupRailSteps(head.map(asStep), 0));
  }
  if (numbered.length > 0) {
    railSteps.push(
      ...buildSetupRailSteps(numbered.map(asStep), railSteps.length - head.length),
    );
  }
  return railSteps;
}

/**
 * The gate row the screen pushes for the skills question -- the run's OWN row
 * component, so the rail's anchors read the same way a conformance walk reads
 * them on the page.
 */
function skillsGateRow(): RunSurfaceRailStep {
  return {
    key: "recommendation",
    row: <RecommendationRailStepRow settled={false} openable />,
    surface: <span>the skills card</span>,
    reached: true,
  };
}

/**
 * The rail as a reader sees it: every row title, in order.
 *
 * BOTH VOCABULARIES, because the rail draws two kinds of row: the gate step
 * brings its own anchored row (`data-recommendation-rail-step`) and the generic
 * rows carry the rail's own (`data-run-surface-rail-step`). Reading only one of
 * them would count the rail short and call a one-entry rail a two-entry one.
 */
const RAIL_ROW_SELECTOR = "[data-run-surface-rail-step],[data-recommendation-rail-step]";

function railRows(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll(RAIL_ROW_SELECTOR));
}

function railRowTitles(container: HTMLElement): string[] {
  return railRows(container).map((row) =>
    (row.textContent ?? "").replace(/^\d+/, "").trim(),
  );
}

describe("a run held at Skills with no input form still draws its whole lifecycle", () => {
  it("draws the steps still to come beneath the gate, not the gate alone", () => {
    const railSteps = skillsOnlyRail({
      hasExecution: false,
      gateRow: skillsGateRow(),
    });
    const view = render(
      <RunSurfaceRail
        steps={railSteps}
        detail="the run detail"
        initialSelection="recommendation"
      />,
    );

    expect(railRowTitles(view.container)).toEqual(["Skills", "Schedule", "Review"]);
    // And the gate keeps the head of the rail, where the drawing stands it.
    const rows = railRows(view.container);
    expect(rows.length).toBeGreaterThan(1);
    expect((rows[0].textContent ?? "").trim()).toContain("Skills");
  });

  it("stops where the run's own history starts: an executed run draws none", () => {
    const railSteps = skillsOnlyRail({
      hasExecution: true,
      gateRow: skillsGateRow(),
    });
    expect(railSteps.map((step) => step.key)).toEqual(["recommendation"]);
  });
});

describe("railDrawsUpcomingRunSteps -- the gate carries the rows too", () => {
  it("rides for a rail headed by the gate step with no input step at all", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: false,
        gateStepInRail: true,
        hasExecution: false,
      }),
    ).toBe(true);
  });

  it("draws none for a rail with neither an input step nor a gate step", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: false,
        gateStepInRail: false,
        hasExecution: false,
      }),
    ).toBe(false);
  });

  it("draws none once the gate's run has an execution record", () => {
    expect(
      railDrawsUpcomingRunSteps({
        inputStepIsOpen: false,
        inputStepsInRail: false,
        gateStepInRail: true,
        hasExecution: true,
      }),
    ).toBe(false);
  });
});
