// @vitest-environment jsdom
/**
 * THE RAIL KEEPS ITS STEPS THROUGH THE LOADING STATE (cinatra#3246).
 *
 * The issue, in the product's own words: "right after a person answers the
 * run's Skills question and the run starts working, the list of steps beside it
 * briefly drops down to showing only the Skills entry -- the schedule, review
 * and other steps that were listed a moment ago disappear until the run has
 * actually produced something."
 *
 * The ratified drawing, the review surface, section I: the rail lists "the
 * ordinary work steps", with "steps already passed sit above it, steps still to
 * come below ... so the rail is the run's whole lifecycle at a glance, not just
 * its live tip" -- and the same section's own loading example, captioned
 * "Before -- the output has not been generated", draws a rail whose last entry
 * is an upcoming Review row while the detail carries only the spinner. The
 * drawing therefore keeps the steps still to come at exactly the moment the
 * code dropped them.
 *
 * AND IT INVENTS NONE. The same section: "Where the run carries a schedule, the
 * rail's first entry is Schedule" -- so a run that carries none is drawn none,
 * which is cinatra#3478's ratified acceptance and the reading the third arm
 * below pins at the very moment this fix widens.
 *
 * WHERE IT WENT. `runHasExecutionRecord` answers `running` from the status
 * alone -- deliberately, and cinatra#3184's table is not touched here -- so at
 * the first render in which the status reads `running` and the run has written
 * no step result, no message and no streamed text, the rail's own answer
 * `railDrawsUpcomingRunSteps` was handed `hasExecution: true` and the rows the
 * reader had a moment earlier stopped.
 *
 * WHAT IS PINNED HERE. The rail is composed through the SAME three calls the
 * screen makes and rendered through the run's own `RunSurfaceRail`, with the
 * gate row drawn by `RecommendationRailStepRow`, and the rows are read back the
 * way a conformance walk reads them -- `[data-run-surface-rail-step]` and
 * `[data-recommendation-rail-step]`, in order. The last arm reads the screen's
 * own source, so a suite that composes the calls itself cannot drift from the
 * screen.
 *
 * WHY THE PREDICATE IS READ OFF THE MODULE BY NAME. Each arm below is meant to
 * carry its OWN reading at the branch base: the loading and monotonic arms red
 * there, the carried-keys and history arms green there. A bare named import of
 * a predicate the base does not have would fail the whole file and take the
 * green arms' readings with it, so the composition falls back to the plain
 * record answer when the predicate is absent -- which is precisely what the
 * screen computed at the base.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/rail-keeps-its-steps-through-the-loading-state-3246.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as instanceScreens from "../instance-screens";
import {
  railDrawsUpcomingRunSteps,
  runHasExecutionRecord,
  upcomingRunRailStepKeys,
} from "../instance-screens";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { RunSurfaceRail, type RunSurfaceRailStep } from "../run-surface-rail";
import { runSurfaceStepDrawsGlyph } from "../run-surface-rail-step";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

afterEach(() => {
  cleanup();
});

/** The four fields of the run's own row every reading below is taken from. */
type RunRow = {
  runStatus: string | null;
  stepResultCount: number;
  runMessageCount: number;
  streamedTextLength: number;
};

/** The run row as the reader's PRIOR render carries it: the Skills question has
 *  been answered and the dispatch has landed, nothing else has happened. */
const THE_PRIOR_RENDER: RunRow = {
  runStatus: "queued",
  stepResultCount: 0,
  runMessageCount: 0,
  streamedTextLength: 0,
};

/** The same run one moment later: it is IN its execution and has produced
 *  nothing. This is the loading reading the issue is about. */
const THE_LOADING_RENDER: RunRow = {
  runStatus: "running",
  stepResultCount: 0,
  runMessageCount: 0,
  streamedTextLength: 0,
};

/** And the render after its first row is written. */
const THE_FIRST_ROW_RENDER: RunRow = {
  runStatus: "running",
  stepResultCount: 1,
  runMessageCount: 0,
  streamedTextLength: 0,
};

/**
 * THE STILL-TO-COME KEYS A RUN ACTUALLY CARRIES, as the screen reads them from
 * the run's own rows: its recommendation park, its trigger row, its gate list.
 * A run that holds neither a trigger row nor a pending review gate carries
 * neither key, and the rail draws neither for it.
 */
const CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW = [
  "recommendation",
  "schedule",
  "review",
] as const;
const CARRIES_NEITHER = ["recommendation"] as const;

const runInExecutionWithoutRecord = (
  instanceScreens as unknown as {
    runInExecutionWithoutRecord?: (params: RunRow) => boolean;
  }
).runInExecutionWithoutRecord;

/**
 * The run page's rail for a run whose first gate is its Skills question --
 * composed from the same three calls the screen makes, with the gate row
 * standing in for the screen's own `recommendation` entry, and the carried keys
 * handed over exactly where the screen hands them over: only while the run is
 * inside its execution with nothing of its own written yet.
 */
function railForRun(params: {
  row: RunRow;
  carries: readonly string[];
  railEligible?: boolean;
}): RunSurfaceRailStep[] {
  // THE RAIL'S OWN ELIGIBILITY, the second fact the screen's own condition
  // reads (convergence): a rail that carries neither the run's input steps nor
  // its gate row was never owed a forecast row, and the loading moment does not
  // make it owed one.
  const railCarriesAGateRow = params.railEligible !== false;
  const railSteps: RunSurfaceRailStep[] = railCarriesAGateRow
    ? [skillsGateRow()]
    : [];
  const insideExecutionWithNothingYet =
    railCarriesAGateRow &&
    (runInExecutionWithoutRecord
      ? runInExecutionWithoutRecord(params.row)
      : false);
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: false,
      inputStepsInRail: false,
      gateStepInRail: railCarriesAGateRow,
      hasExecution: runHasExecutionRecord(params.row),
    }),
    drawnKeys: railSteps.map((step) => step.key),
    ...(insideExecutionWithNothingYet
      ? {
          runCarries: {
            keys: params.carries,
            throughTheLoadingMoment: true,
          },
        }
      : {}),
  } as Parameters<typeof upcomingRunRailStepKeys>[0]);
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

/** The settled gate row the screen pushes for the answered Skills question --
 *  the run's OWN row component, so the rail's anchors read the same way a
 *  conformance walk reads them on the page. */
function skillsGateRow(): RunSurfaceRailStep {
  return {
    key: "recommendation",
    row: <RecommendationRailStepRow settled openable />,
    surface: <span>the skills card</span>,
    reached: true,
  };
}

/**
 * BOTH VOCABULARIES, because the rail draws two kinds of row: the gate step
 * brings its own anchored row and the generic rows carry the rail's own.
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

/** Render the composed rail the way the run page draws it, and read its rows. */
function renderRail(params: {
  row: RunRow;
  carries: readonly string[];
}): { titles: string[]; count: number } {
  const view = render(
    <RunSurfaceRail
      steps={railForRun(params)}
      detail="the run detail"
      initialSelection="recommendation"
    />,
  );
  const titles = railRowTitles(view.container);
  return { titles, count: titles.length };
}

describe("cinatra#3246 acceptance 1 — the loading state keeps every entry the reader was shown", () => {
  it("draws Skills, Schedule and Review while the run works with nothing produced yet", () => {
    const reading = renderRail({
      row: THE_LOADING_RENDER,
      carries: CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW,
    });

    expect(reading.titles).toEqual(["Skills", "Schedule", "Review"]);
    // And never the Skills entry alone, which is the issue's headline.
    expect(reading.count).toBeGreaterThan(1);
  });
});

describe("cinatra#3246 acceptance 2 — the entry count never drops", () => {
  it("keeps at least the rows the prior render carried when the run starts working", () => {
    const prior = renderRail({
      row: THE_PRIOR_RENDER,
      carries: CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW,
    });
    cleanup();
    const loading = renderRail({
      row: THE_LOADING_RENDER,
      carries: CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW,
    });

    expect(prior.count).toBe(3);
    expect(loading.count).toBeGreaterThanOrEqual(prior.count);
  });
});

describe("cinatra#3246 — the rail invents no step the run does not carry", () => {
  it("draws no Schedule and no Review row at the loading moment for a run that carries neither", () => {
    const reading = renderRail({
      row: THE_LOADING_RENDER,
      carries: CARRIES_NEITHER,
    });

    expect(reading.titles).toEqual(["Skills"]);
    expect(reading.titles).not.toContain("Schedule");
    expect(reading.titles).not.toContain("Review");
  });
});

describe("cinatra#3246 — the ride lifts only the execution suppression", () => {
  it("draws none at the loading moment for a rail carrying no input step and no gate row", () => {
    expect(
      railForRun({
        row: THE_LOADING_RENDER,
        carries: CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW,
        railEligible: false,
      }).map((step) => step.key),
    ).toEqual([]);
  });
});

describe("cinatra#3246 — the run's own history still stops the still-to-come rows", () => {
  it("draws none once the run has written its first row", () => {
    expect(
      railForRun({
        row: THE_FIRST_ROW_RENDER,
        carries: CARRIES_ITS_SCHEDULE_AND_ITS_REVIEW,
      }).map((step) => step.key),
    ).toEqual(["recommendation"]);
  });
});

describe("cinatra#3246 — the screen hands the rail the keys this run carries", () => {
  const SCREEN_SRC = fs.readFileSync(
    path.join(__dirname, "..", "instance-screens.tsx"),
    "utf-8",
  );

  it("passes the carried keys after drawnKeys and leaves the rail's own answer alone", () => {
    const callStart = SCREEN_SRC.indexOf(
      "const upcomingRailStepKeys = upcomingRunRailStepKeys({",
    );
    expect(callStart).toBeGreaterThan(-1);
    const call = SCREEN_SRC.slice(callStart, SCREEN_SRC.indexOf("});", callStart));

    // THE RAIL'S OWN ANSWER IS UNTOUCHED: the four arguments the screen has
    // always handed `railDrawsUpcomingRunSteps` stand, and the execution
    // reading it takes is the plain one -- which is what keeps every existing
    // source pin over this call green.
    expect(call).toMatch(/hasExecution: runHasExecution,/);
    // AND THE ONE NEW ARGUMENT IS WRITTEN AFTER `drawnKeys`, so a pin anchored
    // through `drawnKeys` still matches the call it was written for.
    expect(call).toMatch(
      /drawnKeys: railSteps\.map\(\(step\) => step\.key\),[\s\S]*runCarries:/,
    );
    // AND IT IS THE SCREEN'S OWN DERIVATION THAT IS HANDED OVER, by name, so
    // this arm cannot stay green over a call that passes a constant, `undefined`
    // or some other run's reading.
    expect(call).toContain("runCarries: runCarriesStillToComeKeys,");
    // The fact itself is read from the run's own row, not invented at the call.
    expect(SCREEN_SRC).toContain("runInExecutionWithoutRecord({");
  });

  it("derives those keys from the run's own rows, gated on the predicate and on the rail's own eligibility", () => {
    const start = SCREEN_SRC.indexOf("const runCarriesStillToComeKeys =");
    expect(start).toBeGreaterThan(-1);
    const derivation = SCREEN_SRC.slice(
      start,
      SCREEN_SRC.indexOf(": undefined;", start),
    );

    // GATED ON BOTH HALVES (convergence): the loading moment AND the rail's own
    // two eligibility facts, so a rail that was never owed a forecast row does
    // not grow one here.
    expect(derivation).toMatch(
      /runInsideExecutionWithNothingYet &&\s*\n?\s*\(inputStepsInRail \|\| hasRecommendationStep\)/,
    );
    // AND EACH OF THE THREE KEYS IS READ FROM THE RUN'S OWN ROW, by the name the
    // screen already reads that row under.
    expect(derivation).toContain("hasRecommendationStep ?");
    expect(derivation).toContain("runCarriesScheduleStep || parkedScheduleStep");
    expect(derivation).toContain('railGates.some((gate) => gate.status === "pending")');
    expect(derivation).toContain("initialReviewGate?.awaiting === true");
  });
});
