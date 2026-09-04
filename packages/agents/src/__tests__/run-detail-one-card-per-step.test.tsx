// @vitest-environment jsdom
//
// ONE CARD PER STEP PAGE, IN THE RUN DETAIL (the conformance-fix leg of
// cinatra#3029, epic #3023 W5).
//
// THE RATIFIED DRAWING, on the run surface:
//
//   "One page per gate -- the step's own card, and nothing else. Selecting a
//    step opens THAT STEP'S PAGE in the run detail, and the page carries the ONE
//    CARD of the step it belongs to. A gate that has already been answered is
//    read the same way, by selecting ITS OWN step: an answered Skills row is
//    NEVER drawn above the HITL card, the review card, the schedule card or any
//    other card, and TWO CARDS ARE NEVER STACKED IN ONE DETAIL."
//
//   "A run is one page, read down a rail. ... a step rail down the left names
//    the run's ordered steps, and the run detail on the right shows the SELECTED
//    step."
//
//   "The rail's LAST entry is the run's own record, and its page lists the run's
//    work."
//
// WHAT WAS WRONG. The run detail composed the run's own record ("what this run
// made") INTO the same fragment as the recommendation card, the verification
// cards and the stepper panel -- and the stepper panel is where the review gate's
// own card opens. So a finished run whose last gate had been reviewed drew the
// run-made panel AND the review-gate card stacked in one detail, which is the
// one thing the sentence above rules out.
//
// THE FIX. The run's own record is a STEP with its OWN page, exactly as the
// drawing has it: the rail's last entry selects it, and the run detail then
// carries that one card and nothing else. Selecting any other step returns the
// detail to that step's own reading, and the run-made panel is not in it.
//
// Run:
//   npx vitest run --config vitest.config.ts \
//     packages/agents/src/__tests__/run-detail-one-card-per-step.test.tsx

import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { RunSurfaceRail } from "../run-surface-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";
import { RunMadePanel } from "../run-made-panel";
import { RUN_MADE_PANEL_TITLE, type RunArtifactRecord } from "../run-artifact-list";
import { runDetailInitialStep } from "../instance-screens";

afterEach(() => cleanup());

const WROTE: RunArtifactRecord = {
  artifactId: "d082b515-a917-4068-8846-4169bc4b9a94",
  representationRevisionId: "3b0f991f-9124-4133-ab38-f0fea7128c17",
  role: "wrote",
  title: "How Small Teams Keep a Content Calendar",
  objectTypeId: "@cinatra-ai/blog-post-artifact:post",
  mime: "text/markdown",
};

/** The two steps the defect stacked: a review gate step, and the run's own
 *  record. `detail` stands for the run's ordinary reading behind them. */
function frame(initialSelection: "review" | "runMade" | "detail") {
  const steps: RunSurfaceRailStep[] = [
    {
      key: "review",
      row: <div data-testid="review-row" />,
      surface: <div data-testid="review-gate-card">Review requested</div>,
    },
    {
      key: "runMade",
      row: null,
      settled: true,
      surface: <RunMadePanel records={[WROTE]} runStatus="completed" />,
    },
  ];
  return render(
    <RunSurfaceRail
      steps={steps}
      rail={<div data-testid="page-rail" />}
      detail={<div data-testid="run-detail-fallback">the run's ordinary reading</div>}
      initialSelection={initialSelection}
    />,
  );
}

describe("two cards are never stacked in one detail", () => {
  it("the run's own record opens ALONE on its own step page", () => {
    const { container } = frame("runMade");
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.textContent).toContain(RUN_MADE_PANEL_TITLE);
    expect(detail.querySelector('[data-testid="review-gate-card"]')).toBeNull();
    expect(detail.querySelector('[data-testid="run-detail-fallback"]')).toBeNull();
  });

  it("the review gate opens ALONE on its own step page -- the record is not under it", () => {
    const { container } = frame("review");
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull();
    expect(detail.textContent).not.toContain(RUN_MADE_PANEL_TITLE);
  });

  it("the run's ordinary reading carries no run-made panel either", () => {
    const { container } = frame("detail");
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.querySelector('[data-testid="run-detail-fallback"]')).not.toBeNull();
    expect(detail.textContent).not.toContain(RUN_MADE_PANEL_TITLE);
  });

  it("the rail keeps its whole history beside whichever page is open", () => {
    // "A resolved gate stays on the rail as read-only history -- its entry keeps
    // its place." Opening the run's own record must not take the rail away.
    const { container } = frame("runMade");
    const rail = container.querySelector("[data-run-step-rail-column]")!;
    expect(rail.querySelector('[data-testid="review-row"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="page-rail"]')).not.toBeNull();
  });
});

describe("the run detail opens on the step the drawing highlights", () => {
  const BASE = {
    hasRecommendationStep: false,
    recommendationHeld: false,
    hasScheduleStep: false,
    hasExecution: true,
    hasRunMadeStep: false,
  };

  it("a finished run opens on its OWN RECORD -- the rail's last entry, active in the drawing", () => {
    expect(runDetailInitialStep({ ...BASE, hasRunMadeStep: true })).toBe("runMade");
  });

  it("a live hold still wins -- the drawing highlights the step the run is PAUSED on", () => {
    expect(
      runDetailInitialStep({
        ...BASE,
        hasRunMadeStep: true,
        hasRecommendationStep: true,
        recommendationHeld: true,
      }),
    ).toBe("recommendation");
  });

  it("a run with no record of its own is unchanged", () => {
    expect(runDetailInitialStep(BASE)).toBe("detail");
  });
});

describe("the screen composes the record as a STEP, not into the stacked detail", () => {
  const SCREEN_SRC = fs.readFileSync(
    path.join(__dirname, "..", "instance-screens.tsx"),
    "utf-8",
  );

  it("mounts the panel as a rail step's own surface", () => {
    expect(SCREEN_SRC).toMatch(/surface: \(?\s*<RunMadePanel/);
  });

  it("mounts it inside the run detail fragment ONLY where it cannot be a step", () => {
    // THE ONE BRANCH THAT KEEPS THE OLD READING. The record's row is the rail's
    // own last entry, so its page can open alone only where that rail stands
    // BESIDE the frame. On the flow branch the rail is the live column INSIDE
    // the run detail, so swapping the detail for the record's page would take
    // the rail away with it — a page with no rail, no history and no way back.
    // There the record stays in the detail, and `runMadeIsAStep` is what says so.
    const start = SCREEN_SRC.indexOf("const detailNode = (");
    expect(start).toBeGreaterThan(-1);
    const end = SCREEN_SRC.indexOf("// THE TWO COLUMNS", start);
    expect(end).toBeGreaterThan(start);
    const detail = SCREEN_SRC.slice(start, end);
    expect(detail).toContain("<RunMadePanel");
    // ONE SEAM ANSWERS IT (cinatra#3149 item 2). The two mounts used to read two
    // separately-written expressions — `runMadeSaysSomething && !runMadeIsAStep`
    // here and `runMadeIsAStep` at the step — and two expressions can drift into
    // both being true, which is the stacking the fourth graded reading measured.
    // They now read ONE placement value, and "stacked" is not a value it can
    // hold (`runMadePlacement`, pinned in `run-made-one-card-per-detail.test.tsx`).
    expect(detail).toMatch(/runMadeWhere === "in-run-detail" \? \(/);
    expect(SCREEN_SRC).toMatch(/const runMadeWhere = runMadePlacement\(/);
    expect(SCREEN_SRC).toMatch(/const runMadeIsAStep = runMadeWhere === "step-page";/);
    expect(SCREEN_SRC).toMatch(/run && runMadeIsAStep/);
    expect(SCREEN_SRC).toMatch(/const runMadeRailAvailable = screenDrawsPageRail\(/);
  });

  it("opens on the record only where the record is a step", () => {
    expect(SCREEN_SRC).toMatch(/hasRunMadeStep: runMadeIsAStep,/);
  });

  it("gives the record its own selection key on the rail", () => {
    const STEP_SRC = fs.readFileSync(
      path.join(__dirname, "..", "run-surface-rail-step.ts"),
      "utf-8",
    );
    expect(STEP_SRC).toMatch(/export type RunStepSelection =[^;]*"runMade"/);
  });
});

// ---------------------------------------------------------------------------
// A RAIL ROW IS A CONTROL ONLY WHERE IT OPENS SOMETHING, AND IT OPENS FROM THE
// KEYBOARD (the convergence leg).
//
// "Selecting a step opens it on the right." Two things that reading needs and
// did not have: a row must not present itself as pressable where the frame
// carries no such step (the frame refuses the selection, so the press does
// nothing), and a row a reader PRESSES must be reachable and operable without a
// mouse. `StepperTrigger` calls `preventDefault()` on Enter and Space, which
// suppresses the native click a button would synthesise, and it emits
// `tabIndex="-1"` for every row the stepper has not internally selected — and a
// FINISHED rail has none.
// ---------------------------------------------------------------------------

const RUN_MADE_ENTRY: RunStepRailEntry = {
  key: "runMade",
  ordinal: 99,
  kind: "runMade",
  label: "Done",
  status: "completed",
  sources: [],
  runMade: { artifactCount: 1 },
};

const WORK_ENTRY: RunStepRailEntry = {
  key: "step:1",
  ordinal: 1,
  kind: "step",
  label: "Draft the post",
  status: "completed",
  sources: [],
};

/** The production shape: the record's row rides in the page's own rail, BESIDE
 *  the frame, and the frame carries the record as a step with no row of its own. */
function railBesideFrame(options: { carriesTheStep: boolean }) {
  const steps: RunSurfaceRailStep[] = options.carriesTheStep
    ? [
        {
          key: "runMade",
          row: null,
          settled: true,
          surface: <RunMadePanel records={[WROTE]} runStatus="completed" />,
        },
      ]
    : [];
  return render(
    <RunSurfaceRail
      steps={steps}
      rail={
        <RunStepRailPanel
          entries={[WORK_ENTRY, RUN_MADE_ENTRY]}
          activeOrdinal={null}
          reviewHrefBase="/review"
        />
      }
      detail={<div data-testid="run-detail-fallback">the run's ordinary reading</div>}
      initialSelection="detail"
    />,
  );
}

const rowOf = (container: HTMLElement, kind: string) =>
  container.querySelector(`[data-rail-kind="${kind}"] [data-slot="stepper-trigger"]`) as
    | HTMLButtonElement
    | null;

describe("the rail's rows are controls a keyboard can work", () => {
  it("the record's row opens its page on ENTER, not only on a mouse press", () => {
    const { container } = railBesideFrame({ carriesTheStep: true });
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.textContent).not.toContain(RUN_MADE_PANEL_TITLE);
    fireEvent.keyUp(rowOf(container, "runMade")!, { key: "Enter" });
    expect(detail.textContent).toContain(RUN_MADE_PANEL_TITLE);
  });

  it("a work step's row returns the detail on SPACE — the way back from the record", () => {
    const { container } = railBesideFrame({ carriesTheStep: true });
    fireEvent.click(rowOf(container, "runMade")!);
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.textContent).toContain(RUN_MADE_PANEL_TITLE);
    fireEvent.keyUp(rowOf(container, "step")!, { key: " " });
    expect(detail.querySelector('[data-testid="run-detail-fallback"]')).not.toBeNull();
    expect(detail.textContent).not.toContain(RUN_MADE_PANEL_TITLE);
  });

  it("keeps the rows a keyboard can reach — an explicit tab stop, not the stepper's -1", () => {
    const { container } = railBesideFrame({ carriesTheStep: true });
    expect(rowOf(container, "runMade")!.getAttribute("tabindex")).toBe("0");
    expect(rowOf(container, "step")!.getAttribute("tabindex")).toBe("0");
  });

  it("announces the open row as selected, not as tab-selected FALSE", () => {
    const { container } = railBesideFrame({ carriesTheStep: true });
    fireEvent.click(rowOf(container, "runMade")!);
    const row = rowOf(container, "runMade")!;
    expect(row.getAttribute("aria-current")).toBe("step");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("stays INERT where the frame carries no record step — no false affordance", () => {
    const { container } = railBesideFrame({ carriesTheStep: false });
    const row = rowOf(container, "runMade")!;
    expect(row.getAttribute("tabindex")).toBe("-1");
    expect(row.getAttribute("data-action")).toBeNull();
    fireEvent.keyUp(row, { key: "Enter" });
    const detail = container.querySelector("[data-run-detail-column]")!;
    expect(detail.querySelector('[data-testid="run-detail-fallback"]')).not.toBeNull();
  });
});
