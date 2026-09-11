// @vitest-environment jsdom
//
// THE STEP THE RUN IS PAUSED ON IS HIGHLIGHTED — ON EVERY GATE KIND
// (cinatra#3221, fix leg 2).
//
// The ratified drawing, the agent run surface, "The step rail — merged steps
// and gate entries":
//
//   "The rail lists the run's steps in order, merged so that a gate is not a
//    page outside the run but a step in the run: the ordinary work steps, and —
//    inline at the point the run reached it — a gate entry (a Skills step to
//    answer, a list to pick one thing from, a review to decide). The step the
//    run is paused on is highlighted; steps already passed sit above it, steps
//    still to come below."
//
// The first proof round graded four gate readings of real runs. Three elected
// exactly one entry. The fourth — a run stopped in front of a "Draft Context"
// human-in-the-loop screen, its Continue on screen — elected NONE, in both
// palettes: that gate was on no rail at all, so the frame's election had
// nothing to elect and fell through to the run's own detail.
//
// WHAT IS PINNED HERE, per cinatra#3221's own acceptance:
//   • item 1 — one elected entry per gate kind, and it is the parked one;
//   • item 3 — the entries either side of it read as passed and still-to-come;
//   • item 4 — a run with no gate open and nothing pending elects NOTHING, so
//     item 1 cannot be satisfied by always highlighting something.
//
// NOTHING IS HARD-CODED: every selection is computed through
// `runDetailInitialStep` — the very ladder the screen calls — so a change that
// inverts it fails here instead of agreeing with a literal typed into a
// harness.
//
// THE REVIEW GATE OF A LIVE RUN is elected by the run page's MERGED rail, not
// by this frame (`orchestrator-stepper-panel`, pinned by
// `run-rail-active-step.test.tsx`). Its case below is the review step as the
// run-surface frame carries it, which is this frame's half of the same rule.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/run-surface-rail-parked-gate-election.test.tsx

import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunSurfaceRail, RunSurfaceRailRow } from "../run-surface-rail";
import { buildSetupRailSteps, type SetupRailStep } from "../setup-run-surface-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import type { RunInputStep } from "../run-input-steps";
import {
  isRunSurfaceStepSelectable,
  runSurfaceRailNumberedCount,
  type RunStepSelection,
  type RunSurfaceRailStep,
} from "../run-surface-rail-step";
import {
  parkedGateRailStepLabel,
  runDetailInitialStep,
  runParkedAtTrailingGate,
  PARKED_GATE_RAIL_STEP_FALLBACK_LABEL,
} from "../instance-screens";

/**
 * THE REAL PAYLOAD SHAPE (convergence round, fix leg 2). The context-selection
 * payload is SPREAD into the interrupt's values, so `slotMeta` sits BESIDE
 * `candidates` and `selectedRefs` on the values record itself -- that is the
 * shape `execution.ts` recognises a context gate by (`parsed["slotMeta"]`), the
 * shape `hitl-gate-submit.ts` lifts the trusted slot from (`vals["slotMeta"]`),
 * and the shape the card reads its own title out of (`v.slotMeta?.slotId`).
 * This fixture is that shape and nothing else, because a fixture that invents a
 * nesting the runtime never writes proves the label ladder against a payload no
 * gate ever sends -- which is exactly how the first draft of this leaf came to
 * say "Context" on a gate whose card says "Draft Context".
 */
const CONTEXT_GATE_VALUES: Record<string, unknown> = {
  candidates: [],
  selectedRefs: [],
  slotMeta: { slotId: "draftContext", resolutionMode: "accumulate" },
};

afterEach(() => {
  cleanup();
});

const ROW_SEL = "[data-run-surface-rail-step]";

/** The run detail the screen composes, which every step falls back to. */
const DETAIL = <div data-testid="run-detail">the run detail</div>;

/** One answered input form, as the screen's builder describes it. */
function inputStep(over: Partial<RunInputStep> = {}): RunInputStep {
  return {
    key: "input:0",
    label: "Setup",
    fields: ["idea"],
    answered: true,
    open: false,
    reached: true,
    settled: true,
    answers: [{ field: "idea", label: "Idea", value: "A post about rails" }],
    ...over,
  };
}

/**
 * The trailing gate entry the run screen pushes for the gate the run is stopped
 * at — composed here exactly as `instance-screens.tsx` composes it, through the
 * same label leaf and the same selectability predicate.
 */
function parkedGateRailStep(
  above: readonly RunSurfaceRailStep[],
  label: string,
): RunSurfaceRailStep {
  const step: RunSurfaceRailStep = {
    key: "gate",
    reached: true,
    settled: false,
    surface: null,
    row: null,
  };
  return {
    ...step,
    row: (
      <RunSurfaceRailRow
        selectionKey="gate"
        label={label}
        displayStep={runSurfaceRailNumberedCount(above.map((s) => s.key)) + 1}
        reached
        settled={false}
        selectable={isRunSurfaceStepSelectable(step, DETAIL)}
        conformanceId="run-surface-rail-step"
        indicatorConformanceId="run-surface-rail-indicator"
        action="open-gate-step"
      />
    ),
  };
}

function setupSteps(steps: readonly SetupRailStep[]): RunSurfaceRailStep[] {
  return buildSetupRailSteps(steps);
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

// ---------------------------------------------------------------------------
// THE FOUR GATE KINDS, each composed the way the screen composes it, each with
// the selection the screen's own ladder returns for it.
// ---------------------------------------------------------------------------

type GateCase = {
  name: string;
  steps: RunSurfaceRailStep[];
  initial: RunStepSelection;
  parked: string;
};

function gateCases(): GateCase[] {
  // (1) THE SETUP INPUT FORM the run is standing at.
  const openForm = buildRunInputRailSteps(
    [inputStep({ answered: false, open: true, settled: false })],
    DETAIL,
  );
  const inputCase: GateCase = {
    name: "a setup input form the run is standing at",
    steps: [...openForm, ...setupSteps([{ key: "schedule", surface: null, reached: false }])],
    initial: runDetailInitialStep({
      openInputStepKey: "input:0",
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: false,
      hasExecution: false,
    }),
    parked: "input:0",
  };

  // (2) THE SCHEDULE STEP of a run that is armed but has not fired.
  const scheduleCase: GateCase = {
    name: "the schedule step of a run that has not fired",
    steps: setupSteps([{ key: "schedule", surface: <div>schedule</div> }]),
    initial: runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: true,
      hasExecution: false,
    }),
    parked: "schedule",
  };

  // (3) THE CONTEXT-SELECTION SCREEN the agent opened mid-run — the reading the
  // first proof round photographed with nothing highlighted. The form above it
  // is answered history; the gate arrives at the run's live tip.
  const answered = buildRunInputRailSteps([inputStep()], DETAIL);
  const parked = runParkedAtTrailingGate({
    runStatus: "pending_approval",
    lifecycleMoment: "hitl",
    gateContextUsable: true,
    recommendationHeld: false,
    openInputStepKey: null,
  });
  const contextCase: GateCase = {
    name: "a context-selection screen the agent opened mid-run",
    steps: [
      ...answered,
      parkedGateRailStep(
        answered,
        parkedGateRailStepLabel({
          values: CONTEXT_GATE_VALUES,
          fieldName: null,
        }),
      ),
    ],
    initial: runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: false,
      hasExecution: true,
      parkedGateStep: parked,
    }),
    parked: "gate",
  };

  // (4) THE SKILLS QUESTION — the run's first gate, held.
  const skillsCase: GateCase = {
    name: "the skills question, held",
    steps: setupSteps([
      { key: "recommendation", surface: <div>skills</div>, reached: true },
      { key: "schedule", surface: null, reached: false },
    ]),
    initial: runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: true,
      recommendationHeld: true,
      hasScheduleStep: false,
      hasExecution: false,
    }),
    parked: "recommendation",
  };

  // (5) THE REVIEW STEP as this frame carries it.
  const reviewCase: GateCase = {
    name: "a review step this frame carries",
    steps: setupSteps([
      { key: "recommendation", surface: <div>skills</div>, reached: true, settled: true },
      { key: "review", surface: <div>review</div>, reached: true },
    ]),
    initial: "review",
    parked: "review",
  };

  return [inputCase, scheduleCase, contextCase, skillsCase, reviewCase];
}

describe("a run parked on a gate elects exactly one rail entry, the parked one (item 1)", () => {
  for (const gate of gateCases()) {
    it(`elects one entry, and it is the parked one, on ${gate.name}`, () => {
      const { container } = renderRail(gate.steps, gate.initial);
      const rows = railReading(container);
      expect(rows.length).toBeGreaterThan(0);
      const elected = rows.filter((row) => row.selected);
      expect(elected).toHaveLength(1);
      expect(elected[0]!.key).toBe(gate.parked);
      expect(elected[0]!.ariaCurrent).toBe("step");
      // AND NOTHING ELSE CARRIES THE ANCHOR: `aria-current` is the assistive
      // reading of the same election, so two of them is two you-are-here
      // answers on one rail.
      expect(rows.filter((row) => row.ariaCurrent === "step")).toHaveLength(1);
    });
  }
});

describe("the entries either side of the elected one read as passed and still to come (item 3)", () => {
  it("keeps the answered form above the parked gate as settled history", () => {
    const gate = gateCases().find((c) => c.parked === "gate")!;
    const { container } = renderRail(gate.steps, gate.initial);
    const rows = railReading(container);
    expect(rows.map((row) => row.key)).toEqual(["input:0", "gate"]);
    expect(rows[0]!.settled).toBe(true);
    expect(rows[0]!.selected).toBe(false);
    expect(rows[1]!.settled).toBe(false);
    expect(rows[1]!.selected).toBe(true);
  });
});

describe("a run with no gate open and nothing pending elects no entry (item 4)", () => {
  it("elects nothing when the run's forms are answered and no gate is open", () => {
    const answered = buildRunInputRailSteps([inputStep()], DETAIL);
    const initial = runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: false,
      hasExecution: true,
      parkedGateStep: runParkedAtTrailingGate({
        runStatus: "running",
        lifecycleMoment: null,
        gateContextUsable: false,
        recommendationHeld: false,
        openInputStepKey: null,
      }),
    });
    expect(initial).toBe("detail");
    const { container } = renderRail(answered, initial);
    expect(railReading(container).filter((row) => row.selected)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE RULES THEMSELVES, pinned without a render, a session or a DB.
// ---------------------------------------------------------------------------

describe("runParkedAtTrailingGate — which runs own a trailing gate entry", () => {
  const base = {
    runStatus: "pending_approval",
    lifecycleMoment: "hitl" as string | null,
    gateContextUsable: true,
    recommendationHeld: false,
    openInputStepKey: null,
  };

  it("is the run stopped at a mid-run human-in-the-loop screen", () => {
    expect(runParkedAtTrailingGate(base)).toBe(true);
  });

  it("is not a run that is not stopped at all", () => {
    expect(runParkedAtTrailingGate({ ...base, runStatus: "running" })).toBe(false);
    expect(runParkedAtTrailingGate({ ...base, runStatus: null })).toBe(false);
  });

  it("is not a review gate — that entry arrives on the spine", () => {
    expect(runParkedAtTrailingGate({ ...base, lifecycleMoment: "review" })).toBe(false);
    expect(runParkedAtTrailingGate({ ...base, lifecycleMoment: null })).toBe(false);
  });

  it("is not a gate an entry above already draws", () => {
    expect(runParkedAtTrailingGate({ ...base, recommendationHeld: true })).toBe(false);
    expect(runParkedAtTrailingGate({ ...base, openInputStepKey: "input:0" })).toBe(false);
  });

  it("fails closed when the gate's own context could not be read", () => {
    expect(runParkedAtTrailingGate({ ...base, gateContextUsable: false })).toBe(false);
  });

  // CONVERGENCE ROUND, fix leg 2. `deriveRunHitlContext` has a synthetic last
  // resort for a WayFlow gate whose interrupt is gone and whose durable row lost
  // its renderer: a context object that is NOT null and carries an EMPTY
  // `xRenderer`. The panel refuses to draw it, so a row elected for it would
  // open the empty column the ruling forbids. "Usable" is the renderer's
  // presence, which is what the screen passes and what this pins.
  it("fails closed on a context that exists but carries no renderer", () => {
    const usable = (xRenderer: string) => (xRenderer ?? "").length > 0;
    expect(runParkedAtTrailingGate({ ...base, gateContextUsable: usable("") })).toBe(
      false,
    );
    expect(
      runParkedAtTrailingGate({
        ...base,
        gateContextUsable: usable("cinatra:context-selector"),
      }),
    ).toBe(true);
  });
});


describe("parkedGateRailStepLabel — the row says what the gate's own card says", () => {
  it("names the context slot the gate is selecting for", () => {
    expect(
      parkedGateRailStepLabel({
        values: CONTEXT_GATE_VALUES,
        fieldName: "someField",
      }),
    ).toBe("Draft Context");
  });

  // CONVERGENCE ROUND, fix leg 2: the leaf used to scan one level DOWN, through
  // each value of the record, and so found nothing in the shape the runtime
  // actually writes. This is the card's own read, on the card's own payload.
  it("reads the slot off the values record itself, where the payload puts it", () => {
    expect(parkedGateRailStepLabel({ values: CONTEXT_GATE_VALUES, fieldName: null })).toBe(
      "Draft Context",
    );
    // A nesting the runtime never writes is NOT a slot: it must not be mistaken
    // for one, or a stray value could name the row.
    expect(
      parkedGateRailStepLabel({
        values: { someOtherField: { slotMeta: { slotId: "notTheGate" } } },
        fieldName: "toneOfVoice",
      }),
    ).toBe("Tone Of Voice");
  });

  it("falls back to the gate's field name", () => {
    expect(parkedGateRailStepLabel({ values: {}, fieldName: "toneOfVoice" })).toBe(
      "Tone Of Voice",
    );
  });

  it("never humanizes the renderer's wiring placeholder (cinatra#2541)", () => {
    expect(parkedGateRailStepLabel({ values: null, fieldName: "hitl-field" })).toBe(
      PARKED_GATE_RAIL_STEP_FALLBACK_LABEL,
    );
    expect(parkedGateRailStepLabel({ values: null, fieldName: null })).toBe(
      PARKED_GATE_RAIL_STEP_FALLBACK_LABEL,
    );
  });
});

describe("runDetailInitialStep — the parked gate's place in the ladder", () => {
  const base = {
    openInputStepKey: null,
    hasRecommendationStep: false,
    recommendationHeld: false,
    hasScheduleStep: false,
    hasExecution: true,
  };

  it("opens on the parked gate where nothing above it is open", () => {
    expect(runDetailInitialStep({ ...base, parkedGateStep: true })).toBe("gate");
  });

  it("leaves the gates that already head the rail exactly where they were", () => {
    expect(
      runDetailInitialStep({
        ...base,
        hasRecommendationStep: true,
        recommendationHeld: true,
        parkedGateStep: true,
      }),
    ).toBe("recommendation");
    expect(
      runDetailInitialStep({ ...base, openInputStepKey: "input:1", parkedGateStep: true }),
    ).toBe("input:1");
  });

  it("is the run's own detail when no gate is parked", () => {
    expect(runDetailInitialStep({ ...base, parkedGateStep: false })).toBe("detail");
    expect(runDetailInitialStep(base)).toBe("detail");
  });
});

// ---------------------------------------------------------------------------
// AND THE SCREEN ITSELF DRAWS AND ELECTS IT — so the frame cases above cannot
// pass on a harness the screen never composes.
// ---------------------------------------------------------------------------

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

describe("the run screen reads the parked gate ONCE and hands it to both halves", () => {
  it("derives it through the rule, not a second time at the row", () => {
    expect(SCREEN_SRC).toContain("runParkedAtTrailingGate({");
    expect(SCREEN_SRC).toContain("parkedGateRailStepLabel({");
    // ONE fact, handed to the ladder and to the row.
    expect(SCREEN_SRC).toMatch(/runDetailInitialStep\(\{[\s\S]*?parkedGateStep,/);
    expect(SCREEN_SRC).toContain("if (parkedGateStep && parkedGateStepLabel) {");
    // AND IT PASSES THE RENDERER'S PRESENCE, not the context's (convergence
    // round, fix leg 2).
    expect(SCREEN_SRC).toMatch(
      /gateContextUsable: \(initialHitlContext\?\.xRenderer \?\? ""\)\.length > 0,/,
    );
  });

  // CONVERGENCE ROUND, fix leg 2. A parked gate mounts the rail on its own, so
  // the frame answer the two panel branches are handed must count it -- a panel
  // told "no frame" while the frame stands draws its own section plate around a
  // gate card that already has the page, which is the second stacked card the
  // frame contract forbids. The fact is read ABOVE the frame answer for exactly
  // this reason, so the order is pinned too.
  it("counts the parked gate in the frame answer the panels are handed", () => {
    // AND THE SCHEDULING PARK IS COUNTED IN THE SAME ANSWER (cinatra#3221, fix
    // leg 8): a run stopped at its schedule mounts the rail on its own too, and
    // the frame the panels are handed is one answer, not one per gate class.
    expect(SCREEN_SRC).toMatch(
      /const railFramesTheRunDetail =\s*\n\s*inputStepsInRail \|\|\s*\n\s*hasRecommendationStep \|\|\s*\n\s*scheduleRailRef !== null \|\|\s*\n\s*parkedScheduleStep \|\|\s*\n\s*parkedGateStep;/,
    );
    const factAt = SCREEN_SRC.indexOf("const parkedGateStep = runParkedAtTrailingGate({");
    const frameAt = SCREEN_SRC.indexOf("const railFramesTheRunDetail =");
    expect(factAt).toBeGreaterThan(-1);
    expect(frameAt).toBeGreaterThan(factAt);
  });

  it("pushes the gate's row into the rail it elects from", () => {
    expect(SCREEN_SRC).toContain('key: "gate"');
    expect(SCREEN_SRC).toContain('selectionKey="gate"');
    expect(SCREEN_SRC).toContain('action="open-gate-step"');
  });

  it("draws it after the steps the run has passed and before the ones still to come", () => {
    const gateAt = SCREEN_SRC.indexOf("if (parkedGateStep && parkedGateStepLabel) {");
    const inputsAt = SCREEN_SRC.indexOf("railSteps.push(...buildRunInputRailSteps(");
    const upcomingAt = SCREEN_SRC.indexOf("const upcomingRailStepKeys = upcomingRunRailStepKeys({");
    expect(inputsAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(inputsAt);
    expect(upcomingAt).toBeGreaterThan(gateAt);
  });
});
