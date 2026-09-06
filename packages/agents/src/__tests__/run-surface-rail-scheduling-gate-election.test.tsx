// @vitest-environment jsdom
//
// THE SCHEDULING GATE ELECTS ITS OWN ENTRY, TOO (cinatra#3221, fix leg 8).
//
// The ratified drawing, the agent run and review surface, section I ("The step
// rail — merged steps and gate entries"):
//
//   "The step the run is paused on is highlighted; steps already passed sit
//    above it, steps still to come below."
//
// and section II ("The Skills step — the first entry on the rail"): the Skills
// question "is the run's first gate — the first entry on the step rail, where
// it is named Skills, ahead of the work steps it would authorize."
//
// WHAT THE FOURTH PROOF ROUND MEASURED. Legs 6 and 7 closed two gate classes —
// the mid-run context gate and the work review gate. The third, the SCHEDULING
// gate, came back failing on two readings of one run:
//
//   • on the run route the rail elected NOTHING while the schedule form stood
//     in the detail beside it — the schedule was drawn as a still-to-come
//     forecast row, which no election can elect, because the rail drew a
//     schedule row only for a run that already holds a trigger row and a run
//     parked at its schedule has not chosen a trigger yet;
//   • on the trigger route the Schedule step WAS elected, and the unreached
//     Skills entry was drawn ABOVE it — neither passed work above nor work
//     still to come below.
//
// Both roads are composed here the way the screens compose them, through the
// screens' OWN exported rules — the park predicate, the election ladder, the
// forecast-row rules and the shared row builder — so a change that inverts any
// of them fails here instead of agreeing with a literal typed into a harness.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/run-surface-rail-scheduling-gate-election.test.tsx

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunSurfaceRail, RunSurfaceRailRow } from "../run-surface-rail";
import { buildSetupRailSteps, type SetupRailStep } from "../setup-run-surface-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import type { RunInputStep } from "../run-input-steps";
import { RUN_SURFACE_RAIL_LABELS } from "../run-surface-rail-labels";
import {
  isRunSurfaceStepSelectable,
  runSurfaceRailNumberedCount,
  runSurfaceStepDrawsGlyph,
  type RunStepSelection,
  type RunSurfaceRailStep,
} from "../run-surface-rail-step";
import { electRunRailActiveStep } from "../run-step-rail-extra-entry";
import {
  railDrawsUpcomingRunSteps,
  railStepsWithoutAnUnreachedSkillsEntry,
  runDetailInitialStep,
  runParkedAtScheduleGate,
  upcomingRunRailStepKeys,
  upcomingSkillsEntryHeadsTheRail,
  type UpcomingRunRailStepKey,
} from "../instance-screens";

afterEach(() => {
  cleanup();
});

const ROW_SEL = "[data-run-surface-rail-step]";

/** The run detail the screen composes, which every step falls back to. */
const DETAIL = <div data-testid="run-detail">the run detail</div>;

/** The run's answered input form, as the screen's builder describes it. */
function answeredInputStep(): RunInputStep {
  return {
    key: "input:0",
    label: "Setup",
    fields: ["idea"],
    answered: true,
    open: false,
    reached: true,
    settled: true,
    answers: [{ field: "idea", label: "Idea", value: "A post about rails" }],
  };
}

/**
 * The schedule row the run page pushes for a run stopped at its schedule with no
 * trigger row of its own — composed here exactly as `instance-screens.tsx`
 * composes it, through the same label, the same numeral rule and the same
 * selectability predicate.
 */
function parkedScheduleRailStep(above: readonly RunSurfaceRailStep[]): RunSurfaceRailStep {
  const step: RunSurfaceRailStep = {
    key: "schedule",
    reached: true,
    settled: false,
    surface: null,
    row: null,
  };
  return {
    ...step,
    row: (
      <RunSurfaceRailRow
        selectionKey="schedule"
        label={RUN_SURFACE_RAIL_LABELS.schedule}
        displayStep={runSurfaceRailNumberedCount(above.map((s) => s.key)) + 1}
        reached
        settled={false}
        selectable={isRunSurfaceStepSelectable(step, DETAIL)}
        conformanceId="run-surface-rail-step"
        indicatorConformanceId="run-surface-rail-indicator"
        action="open-schedule-step"
      />
    ),
  };
}

/**
 * The run page's still-to-come rows, added the way the screen adds them.
 *
 * `gateStepInRail` is the screen's own `hasRecommendationStep` -- whether the
 * run HOLDS a skills gate step of its own. Both runs composed in this file are
 * parked at their schedule with the Skills entry still a forecast row (that is
 * the reading the file is about: "the unreached Skills entry was drawn ABOVE
 * it"), so the run holds no recommendation step and the mirror passes `false`.
 * The rows still ride, because the run's answered input form rides them.
 */
function withUpcomingRows(railSteps: RunSurfaceRailStep[]): RunSurfaceRailStep[] {
  const keys = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: false,
      inputStepsInRail: true,
      gateStepInRail: false,
      hasExecution: false,
    }),
    drawnKeys: railSteps.map((step) => step.key),
  });
  const asUpcomingStep = (key: UpcomingRunRailStepKey): SetupRailStep => ({
    key,
    reached: false,
    settled: false,
    surface: null,
  });
  const head = keys.filter((key) => runSurfaceStepDrawsGlyph(key));
  const numbered = keys.filter((key) => !runSurfaceStepDrawsGlyph(key));
  const out = [...railSteps];
  if (head.length > 0 && upcomingSkillsEntryHeadsTheRail(railSteps)) {
    out.unshift(...buildSetupRailSteps(head.map(asUpcomingStep), 0));
  }
  if (numbered.length > 0) {
    out.push(
      ...buildSetupRailSteps(
        numbered.map(asUpcomingStep),
        runSurfaceRailNumberedCount(out.map((step) => step.key)),
      ),
    );
  }
  return out;
}

/** THE RUN ROUTE: a run parked at its schedule, holding no trigger row. */
function runRouteReading(): { steps: RunSurfaceRailStep[]; initial: RunStepSelection } {
  const parked = runParkedAtScheduleGate({
    runStatus: "pending_trigger",
    lifecycleMoment: "schedule",
    recommendationHeld: false,
    openInputStepKey: null,
  });
  const answered = buildRunInputRailSteps([answeredInputStep()], DETAIL);
  const railSteps: RunSurfaceRailStep[] = [...answered];
  if (parked) railSteps.push(parkedScheduleRailStep(railSteps));
  return {
    steps: withUpcomingRows(railSteps),
    initial: runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: parked,
      hasExecution: false,
    }),
  };
}

/** THE TRIGGER ROUTE: the same run, on the schedule screen's own composition. */
function triggerRouteReading(): { steps: RunSurfaceRailStep[]; initial: RunStepSelection } {
  const setupSteps: SetupRailStep[] = [
    { key: "recommendation", surface: null, reached: false, settled: false },
    { key: "schedule", surface: <div>the schedule form</div> },
    { key: "review", surface: null, reached: false, settled: false },
  ];
  const answered = buildRunInputRailSteps([answeredInputStep()], null);
  return {
    steps: [
      ...answered,
      ...buildSetupRailSteps(
        railStepsWithoutAnUnreachedSkillsEntry(setupSteps),
        answered.length,
      ),
    ],
    initial: "schedule",
  };
}

function renderRail(steps: readonly RunSurfaceRailStep[], initial: RunStepSelection) {
  return render(
    <div data-run-detail-contract="" data-conformance-id="run-surface">
      <RunSurfaceRail steps={[...steps]} detail={DETAIL} initialSelection={initial} />
    </div>,
  );
}

/** The rows the rail drew, in order, with what each says about itself. */
function railReading(container: HTMLElement) {
  return Array.from(container.querySelectorAll(ROW_SEL)).map((row) => ({
    key: row.getAttribute("data-run-surface-rail-step-key"),
    selected: row.getAttribute("data-run-surface-rail-selected") === "true",
    ariaCurrent: row.getAttribute("aria-current"),
    settled: row.getAttribute("data-run-surface-rail-settled") === "true",
    reached: row.getAttribute("data-run-surface-rail-reached"),
  }));
}

const READINGS = [
  { name: "the run route", read: runRouteReading },
  { name: "the trigger route", read: triggerRouteReading },
] as const;

describe("a run parked at its schedule elects exactly one entry, the schedule (item 1)", () => {
  for (const reading of READINGS) {
    it(`elects the Schedule step on ${reading.name}`, () => {
      const { steps, initial } = reading.read();
      const { container } = renderRail(steps, initial);
      const rows = railReading(container);
      const elected = rows.filter((row) => row.selected);
      expect(elected).toHaveLength(1);
      expect(elected[0]!.key).toBe("schedule");
      expect(elected[0]!.ariaCurrent).toBe("step");
      expect(rows.filter((row) => row.ariaCurrent === "step")).toHaveLength(1);
    });
  }
});

describe("the still-to-come rows sit BELOW the elected one (section II, item 3)", () => {
  for (const reading of READINGS) {
    it(`draws no unreached Skills entry above the Schedule step on ${reading.name}`, () => {
      const { steps, initial } = reading.read();
      const { container } = renderRail(steps, initial);
      const rows = railReading(container);
      const electedAt = rows.findIndex((row) => row.selected);
      expect(electedAt).toBeGreaterThan(-1);
      // Nothing the run has NOT reached stands above the step it is stopped at.
      for (const row of rows.slice(0, electedAt)) {
        expect(row.reached).not.toBe("false");
      }
      // And the unreached Skills forecast is not drawn at all: the question is
      // behind the reader.
      expect(rows.map((row) => row.key)).not.toContain("recommendation");
      // What stands above is the work the run passed; what stands below has not
      // been reached.
      expect(rows[0]!.key).toBe("input:0");
      expect(rows[0]!.settled).toBe(true);
      for (const row of rows.slice(electedAt + 1)) {
        expect(row.reached).toBe("false");
        expect(row.selected).toBe(false);
      }
    });
  }
});

describe("the run's own row is what says it is standing there", () => {
  const parkedAt = (runStatus: string, lifecycleMoment: string | null) =>
    runParkedAtScheduleGate({
      runStatus,
      lifecycleMoment,
      recommendationHeld: false,
      openInputStepKey: null,
    });

  it("reads BOTH statuses the schedule park uses", () => {
    expect(parkedAt("pending_trigger", "schedule")).toBe(true);
    expect(parkedAt("armed", "schedule")).toBe(true);
  });

  it("says nothing for a row that states another moment, or none", () => {
    expect(parkedAt("pending_trigger", "hitl")).toBe(false);
    expect(parkedAt("pending_trigger", null)).toBe(false);
    expect(parkedAt("running", "schedule")).toBe(false);
    expect(parkedAt("completed", "schedule")).toBe(false);
  });

  it("leaves the two entries that outrank it alone", () => {
    expect(
      runParkedAtScheduleGate({
        runStatus: "pending_trigger",
        lifecycleMoment: "schedule",
        recommendationHeld: true,
        openInputStepKey: null,
      }),
    ).toBe(false);
    expect(
      runParkedAtScheduleGate({
        runStatus: "pending_trigger",
        lifecycleMoment: "schedule",
        recommendationHeld: false,
        openInputStepKey: "input:0",
      }),
    ).toBe(false);
  });
});

describe("the live rail's own election answers the schedule park", () => {
  const elect = (status: string) =>
    electRunRailActiveStep({
      status,
      currentStepNumber: null,
      awaitingNextStep: false,
      highestStepNumber: 0,
      spine: [{ index: 1, stepNumber: 1 }],
      railExtras: [{ status: "pending" }],
    });

  it("elects the parked trailing row on both schedule-park statuses", () => {
    expect(elect("pending_trigger")).toBe(2);
    expect(elect("armed")).toBe(2);
  });

  it("leaves a rail with no trailing row exactly as it was", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_trigger",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 0,
        spine: [{ index: 1, stepNumber: 1 }],
        railExtras: [],
      }),
    ).toBe(1);
  });
});
