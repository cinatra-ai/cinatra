// @vitest-environment jsdom
//
// THE SETTLED ROW ON THE SETUP RUN PAGE'S RAIL (cinatra#2970, epic #2784).
//
// The ratified drawing `images/lifecycle-screens/design-run-surface-rail-and-gate.png`:
// "A resolved gate stays on the rail as read-only history — its entry keeps its
// place and records how it was settled." Plan (A) §4.2 says the same about a
// review that has been answered: the outcome is kept "on the run's audit trail
// and on the rail as read-only history".
//
// The run page's own recommendation row has drawn that reading since
// cinatra#2790 — the completed circle in place of the numeral, the title
// unhighlighted. The SETUP run page draws its three rows with the shared row
// instead, and the shared row knew only the numeral: a run whose skills question
// a person had just answered came back to this page still showing "2", and a run
// whose review gate was decided still showed "3". The history the drawing keeps
// was lost on the one screen that has nothing else to show it.
//
// WHAT IS PINNED HERE. The rail row's own reading, measured the way the S9f
// capture record measures it — the circle's TEXT and whether it holds a glyph at
// all — so a row that draws a numeral where the record says the numeral is gone
// fails here rather than in a picture.
//
// WHY THIS FILE AND NOT `setup-run-surface-rail.test.tsx`. That suite stubs
// every icon to nothing so it can drive the shipped cards, which makes the check
// glyph unobservable in it. Here lucide draws for real, so `svg` presence is a
// fact rather than a stand-in — the same fact the capture driver reads.
//
// NOTHING IS HARD-CODED. Every settled answer is derived through the very
// functions the screen calls, so a change that inverts one fails these cases
// instead of agreeing with a literal typed into a harness.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/setup-run-surface-settled-rail.test.tsx

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { RunSurfaceRail } from "../run-surface-rail";
import { buildSetupRailSteps, type SetupRailStep } from "../setup-run-surface-steps";
import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "../recommendation-rail-entry";
import {
  runReviewStepReading,
  runReviewStepSettled,
  type RunReviewSlot,
} from "../run-review-slot-reading";

afterEach(() => {
  cleanup();
});

/** A run's recommendation park, as the screen reads it. */
type ParkFixture = { status: "parked" | "released" | "policy_unresolved" } | null;
/** The run's review gate row status, as the screen reads it. */
type GateFixture = "pending" | "resolved" | null;

type RunFixture = {
  park?: ParkFixture;
  slot?: RunReviewSlot | null;
  gateStatus?: GateFixture;
};

/** A run holding at its skills question. */
const LIVE_HOLD: ParkFixture = { status: "parked" };
/** A run whose skills question a person answered. */
const DECIDED_HOLD: ParkFixture = { status: "released" };
/** A run whose skills question EXPIRED undecided — the TTL sweeper's fail-closed
 *  park. Terminal, and NOBODY decided it. */
const EXPIRED_HOLD: ParkFixture = { status: "policy_unresolved" };
/** A run with a review gate on file. */
const REVIEW_ON_FILE: RunReviewSlot = { reviewTaskId: "rt-2970", awaiting: false };
/** A run that produced something whose review question is still open. */
const AWAITING_REVIEW: RunReviewSlot = { reviewTaskId: null, awaiting: true };

/** A stand-in surface. WHAT a step opens is `setup-run-surface-rail.test.tsx`'s
 *  subject — the shipped cards, resolved. What is under test here is the ROW. */
function StepSurface({ name }: { name: string }) {
  return <div data-testid={`surface-${name}`}>{name}</div>;
}

/**
 * The three setup steps as the setup run page composes them, with the settled
 * reading derived exactly as the screen derives it.
 */
function setupSteps(opts: RunFixture = {}): SetupRailStep[] {
  const park = opts.park ?? null;
  const entry = recommendationRailEntry({
    hasPark: park != null,
    held: park?.status === "parked",
  });
  const opens = recommendationRailStepOpens({ entry, parkStatus: park?.status });
  const reading = runReviewStepReading(opts.slot ?? null);
  const reviewSettled = runReviewStepSettled({
    reading,
    gateStatus: opts.gateStatus ?? null,
  });
  return [
    // THE SCHEDULE STEP CARRIES NO SETTLED READING, and its absence is the
    // finding rather than an omission — see the last describe below.
    { key: "schedule", surface: <StepSurface name="schedule" /> },
    {
      key: "recommendation",
      reached: opens,
      // A TERMINAL PARK IS NOT A DECIDED ONE. `policy_unresolved` reads as
      // `settled` for the ENTRY — the row exists — and nobody answered it, so
      // there is nothing for a completed circle to record.
      settled: entry === "settled" && opens,
      surface: opens ? <StepSurface name="recommendation" /> : null,
    },
    {
      key: "review",
      reached: reading !== "none",
      settled: reviewSettled,
      surface: reading === "none" ? null : <StepSurface name="review" />,
    },
  ];
}

function renderSetupSurface(opts: RunFixture = {}) {
  return render(
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      <RunSurfaceRail steps={buildSetupRailSteps(setupSteps(opts))} initialSelection="schedule" />
    </div>,
  );
}

const ROW_SEL = '[data-conformance-id="run-surface-rail-step"]';
const INDICATOR_SEL = '[data-conformance-id="run-surface-rail-indicator"]';

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(ROW_SEL));
const detailColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-conformance-id="run-detail-column"]')!;

/**
 * THE CAPTURE RECORD'S OWN READING OF A RAIL ROW, transcribed from the S9f
 * driver's `runSurface` block so this suite measures the DOM the pictures are
 * graded on rather than a paraphrase of it: the circle's text, and whether the
 * circle holds a glyph element at all.
 */
function railStepRecord(row: HTMLElement) {
  const indicator = row.querySelector<HTMLElement>(INDICATOR_SEL);
  return {
    railStepIndicatorText: indicator?.textContent?.trim() ?? null,
    railStepIndicatorHasCheckGlyph: Boolean(indicator?.querySelector("svg")),
  };
}

describe("a settled step is the rail's own resolved-gate history row", () => {
  it("puts the completed circle where the numeral was, for a DECIDED recommendation", () => {
    const { container } = renderSetupSurface({ park: DECIDED_HOLD });
    const row = rows(container)[1];

    expect(row.getAttribute("data-run-surface-rail-settled")).toBe("true");
    // The circle records how it was settled: the glyph, and no numeral left
    // behind it.
    expect(railStepRecord(row)).toEqual({
      railStepIndicatorText: "",
      railStepIndicatorHasCheckGlyph: true,
    });
    // …and no status word is added beside the title, because the drawing shows
    // none.
    expect(row.textContent).toBe("Recommendation");
    // The completed circle takes the rail's FILLED tokens, exactly as the run
    // page's settled recommendation row does.
    const indicator = row.querySelector<HTMLElement>(INDICATOR_SEL)!;
    expect(indicator.className).toContain("bg-primary");
    expect(indicator.className).not.toContain("bg-muted-foreground/40");
    // THE TITLE IS UNHIGHLIGHTED: this row is history, not the step the surface
    // is on. The schedule step is the open one here.
    expect(row.querySelector("span:last-of-type")!.className).toContain("text-muted-foreground");
    expect(row.getAttribute("data-run-surface-rail-selected")).toBe("false");
  });

  it("puts it there for a DECIDED review gate too", () => {
    const { container } = renderSetupSurface({
      slot: REVIEW_ON_FILE,
      gateStatus: "resolved",
    });
    const row = rows(container)[2];

    expect(row.getAttribute("data-run-surface-rail-settled")).toBe("true");
    expect(railStepRecord(row)).toEqual({
      railStepIndicatorText: "",
      railStepIndicatorHasCheckGlyph: true,
    });
    expect(row.textContent).toBe("Review");
    expect(
      row.querySelector<HTMLElement>(INDICATOR_SEL)!.className,
    ).toContain("bg-primary");
  });

  it("leaves a LIVE row on its numeral — the step the run is paused on", () => {
    const { container } = renderSetupSurface({ park: LIVE_HOLD, slot: REVIEW_ON_FILE });

    expect(rows(container)[1].getAttribute("data-run-surface-rail-settled")).toBe("false");
    expect(railStepRecord(rows(container)[1])).toEqual({
      railStepIndicatorText: "2",
      railStepIndicatorHasCheckGlyph: false,
    });
    expect(rows(container)[1].textContent).toBe("2Recommendation");
    // A gate that is still open is not history either.
    expect(rows(container)[2].getAttribute("data-run-surface-rail-settled")).toBe("false");
    expect(railStepRecord(rows(container)[2])).toEqual({
      railStepIndicatorText: "3",
      railStepIndicatorHasCheckGlyph: false,
    });
  });

  it("draws NO completed circle for a hold that expired undecided", () => {
    // The ENTRY reads a terminal park as settled — the row keeps its place — and
    // nobody answered it, so there is nothing for the circle to record. A check
    // here would say a person decided something they never saw.
    const { container } = renderSetupSurface({ park: EXPIRED_HOLD });
    const row = rows(container)[1];

    expect(row.getAttribute("data-run-surface-rail-settled")).toBe("false");
    expect(railStepRecord(row)).toEqual({
      railStepIndicatorText: "2",
      railStepIndicatorHasCheckGlyph: false,
    });
    // Still the closed, muted row it already was.
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector<HTMLElement>(INDICATOR_SEL)!.className).toContain(
      "bg-muted-foreground/40",
    );
  });

  it("draws none while the run's review question is still open", () => {
    // The placeholder reading: the run produced something and no gate exists
    // yet, so there is no decision to record.
    const { container } = renderSetupSurface({ slot: AWAITING_REVIEW });
    const row = rows(container)[2];

    expect(row.getAttribute("data-run-surface-rail-settled")).toBe("false");
    expect(railStepRecord(row)).toEqual({
      railStepIndicatorText: "3",
      railStepIndicatorHasCheckGlyph: false,
    });
  });

  it("keeps every anchor the capture recorder measures", () => {
    const { container } = renderSetupSurface({ park: DECIDED_HOLD });
    const row = rows(container)[1];

    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("data-conformance-id")).toBe("run-surface-rail-step");
    expect(row.hasAttribute("data-run-surface-rail-step")).toBe(true);
    expect(row.getAttribute("data-run-surface-rail-step-key")).toBe("recommendation");
    expect(row.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(row.getAttribute("data-action")).toBe("open-recommendation-step");
    expect(row.querySelector(INDICATOR_SEL)).not.toBeNull();
    // One circle per row, still — the glyph is INSIDE the indicator the recorder
    // addresses, never a second element beside it.
    expect(row.querySelectorAll(INDICATOR_SEL).length).toBe(1);
    expect(container.querySelectorAll(ROW_SEL).length).toBe(3);
  });

  it("changes the circle and the title only — the settled row opens what it opened", () => {
    // The fix is the rail's reading. What a settled row OPENS is the branch's
    // own answer and is not touched here.
    const { container } = renderSetupSurface({ park: DECIDED_HOLD });

    expect(rows(container)[1].hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);

    const surface = container.querySelector<HTMLElement>('[data-testid="surface-recommendation"]')!;
    expect(surface).not.toBeNull();
    expect(detailColumn(container).contains(surface)).toBe(true);
    // Selected now — and the circle still records that it was settled.
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(railStepRecord(rows(container)[1])).toEqual({
      railStepIndicatorText: "",
      railStepIndicatorHasCheckGlyph: true,
    });
  });
});

describe("the schedule row keeps its numeral — no settled reading is invented for it", () => {
  it("keeps it for every run this page serves", () => {
    // THE DECISION, and its evidence. The drawing's settled reading is the
    // resolved GATE's — "a resolved gate stays on the rail as read-only
    // history". A schedule is not a gate: plan (A) §7.2 step 5 says the schedule
    // step is opened "to see the configuration or change it", and it draws the
    // line itself — "a trigger decides *when* the agent runs, and a review card
    // exists only after the agent has run".
    //
    // Nor is a schedule finished when it has fired. §7.2: "a run set to
    // **Recurring** that has fired keeps its scheduler editable — the same rows
    // and **Save changes**". Only a fired one-off stops changing, and the plan
    // puts THAT reading in the form, not in the rail: "the form stays as a
    // **read-only** reading with no controls at all" — which this branch already
    // draws in the step's own surface.
    //
    // The run page's own schedule row draws no settled reading either, so one
    // here would make the same step read two ways on two screens.
    for (const opts of [
      {},
      { park: DECIDED_HOLD },
      { slot: REVIEW_ON_FILE, gateStatus: "resolved" as const },
    ]) {
      cleanup();
      const { container } = renderSetupSurface(opts);
      const row = rows(container)[0];
      expect(row.getAttribute("data-run-surface-rail-settled")).toBe("false");
      expect(railStepRecord(row)).toEqual({
        railStepIndicatorText: "1",
        railStepIndicatorHasCheckGlyph: false,
      });
      expect(row.textContent).toBe("1Schedule");
    }
  });
});

describe("runReviewStepSettled — a gate on file is not a gate that was answered", () => {
  it("is the decided gate, and nothing else", () => {
    expect(runReviewStepSettled({ reading: "review", gateStatus: "resolved" })).toBe(true);
    // On file and still open.
    expect(runReviewStepSettled({ reading: "review", gateStatus: "pending" })).toBe(false);
    // No gate to be decided: the placeholder, and the run with no review at all.
    expect(runReviewStepSettled({ reading: "working", gateStatus: null })).toBe(false);
    expect(runReviewStepSettled({ reading: "none", gateStatus: null })).toBe(false);
    // A status nobody wrote is not a decision.
    expect(runReviewStepSettled({ reading: "review", gateStatus: undefined })).toBe(false);
    expect(runReviewStepSettled({ reading: "review", gateStatus: "who-knows" })).toBe(false);
    // And a resolved gate the reading does not name is not this step's history:
    // the row draws the gate the step opens.
    expect(runReviewStepSettled({ reading: "none", gateStatus: "resolved" })).toBe(false);
    expect(runReviewStepSettled({ reading: "working", gateStatus: "resolved" })).toBe(false);
  });
});
