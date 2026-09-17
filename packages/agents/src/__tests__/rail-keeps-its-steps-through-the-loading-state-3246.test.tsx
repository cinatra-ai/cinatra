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
 * `[data-recommendation-rail-step]`, in order. The fourth arm reads the
 * screen's own source, so a suite that composes the calls itself cannot drift
 * from the screen.
 *
 * WHY THE PREDICATE IS READ OFF THE MODULE BY NAME. Each arm below is meant to
 * carry its OWN reading at the branch base: the loading and monotonic arms red
 * there, the history arm green there. A bare named import of a predicate the
 * base does not have would fail the whole file and take the history arm's
 * reading with it, so the composed argument falls back to the bare record
 * answer when the predicate is absent -- which is precisely what the screen
 * computed at the base.
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

const runInExecutionWithoutRecord = (
  instanceScreens as unknown as {
    runInExecutionWithoutRecord?: (params: RunRow) => boolean;
  }
).runInExecutionWithoutRecord;

/**
 * The ONE argument the screen hands the rail's answer: the run's record, minus
 * the moment it is inside an execution and has produced nothing.
 */
function railHasExecutionArgument(row: RunRow): boolean {
  const hasExecution = runHasExecutionRecord(row);
  const nothingYet = runInExecutionWithoutRecord
    ? runInExecutionWithoutRecord(row)
    : false;
  return hasExecution && !nothingYet;
}

/**
 * The run page's rail for a run whose first gate is its Skills question --
 * composed from the same three calls the screen makes, with the gate row
 * standing in for the screen's own `recommendation` entry.
 */
function railForRunRow(row: RunRow): RunSurfaceRailStep[] {
  const railSteps: RunSurfaceRailStep[] = [skillsGateRow()];
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: false,
      inputStepsInRail: false,
      gateStepInRail: true,
      hasExecution: railHasExecutionArgument(row),
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
function renderRail(row: RunRow): { titles: string[]; count: number } {
  const view = render(
    <RunSurfaceRail
      steps={railForRunRow(row)}
      detail="the run detail"
      initialSelection="recommendation"
    />,
  );
  const titles = railRowTitles(view.container);
  return { titles, count: titles.length };
}

describe("cinatra#3246 acceptance 1 — the loading state keeps every entry the reader was shown", () => {
  it("draws Skills, Schedule and Review while the run works with nothing produced yet", () => {
    const reading = renderRail(THE_LOADING_RENDER);

    expect(reading.titles).toEqual(["Skills", "Schedule", "Review"]);
    // And never the Skills entry alone, which is the issue's headline.
    expect(reading.count).toBeGreaterThan(1);
  });
});

describe("cinatra#3246 acceptance 2 — the entry count never drops", () => {
  it("keeps at least the rows the prior render carried when the run starts working", () => {
    const prior = renderRail(THE_PRIOR_RENDER);
    cleanup();
    const loading = renderRail(THE_LOADING_RENDER);

    expect(prior.count).toBe(3);
    expect(loading.count).toBeGreaterThanOrEqual(prior.count);
  });
});

describe("cinatra#3246 — the run's own history still stops the still-to-come rows", () => {
  it("draws none once the run has written its first row", () => {
    expect(railForRunRow(THE_FIRST_ROW_RENDER).map((step) => step.key)).toEqual([
      "recommendation",
    ]);
  });
});

describe("cinatra#3246 — the screen composes the fact into the rail's one argument", () => {
  const SCREEN_SRC = fs.readFileSync(
    path.join(__dirname, "..", "instance-screens.tsx"),
    "utf-8",
  );

  it("hands the rail's answer the composed value, not the bare record answer", () => {
    const callStart = SCREEN_SRC.indexOf("drawUpcoming: railDrawsUpcomingRunSteps({");
    expect(callStart).toBeGreaterThan(-1);
    const call = SCREEN_SRC.slice(callStart, SCREEN_SRC.indexOf("}),", callStart));

    // The composition, in the screen's own spelling: the record answer minus the
    // moment the run is inside an execution and has produced nothing.
    expect(call).toMatch(/hasExecution:\s*runHasExecution\s*&&\s*!\w+/);
    // And never the bare reading the loading state collapsed on.
    expect(call).not.toMatch(/hasExecution:\s*runHasExecution\s*,/);
    // The fact itself is read from the run's row, beside the other two.
    expect(SCREEN_SRC).toContain("runInExecutionWithoutRecord({");
  });
});
