// @vitest-environment jsdom
/**
 * THE SETTLED REVIEW ROW, AS IT RENDERS (cinatra#3080, PR #3100, fix leg 7,
 * added at convergence).
 *
 * Fix leg 7's rail suite reads the source and asserts on the spelling of the
 * template expression that draws this row. That would pass on a row nobody can
 * reach and on a row whose two halves render apart. The drawing's rail draws one
 * sentence — "Review \u00b7 continued" — so this reads the RENDERED row: the label and
 * the settled word in one text, joined by a middot, the word lowercase, and no
 * separate badge beside it.
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Stepper, StepperItem, StepperNav } from "@/components/reui/stepper";

import { RailExtraEntry } from "../run-step-rail-extra-entry";
import type { RunStepRailEntry } from "../run-step-rail";

const settledGate = (settledAct: "continued" | "superseded"): RunStepRailEntry => ({
  key: "gate:g_1",
  ordinal: 4,
  kind: "gate",
  label: "Review",
  status: "resolved",
  sources: [],
  gate: {
    gateId: "g_1",
    reviewTaskId: "rt_1",
    disposition: "APPROVE",
    settledAct,
    resolved: true,
  },
});

const draw = (entry: RunStepRailEntry) =>
  render(
    <Stepper defaultValue={1}>
      <StepperNav>
        <StepperItem step={1} completed>
          <RailExtraEntry entry={entry} reviewHrefBase="/agents/v/p/i/review" />
        </StepperItem>
      </StepperNav>
    </Stepper>,
  );

// UNMOUNT the roots; never wipe the DOM out from under them. A root left
// mounted keeps a scheduled continuation alive, and the scheduler runs it
// AFTER this file's jsdom is torn down - the "window is not defined"
// uncaught exception the full suite tallied twice from this file. cleanup()
// is what every other render suite here uses.
afterEach(() => {
  cleanup();
});

describe("the rail's settled review row, rendered", () => {
  it("reads as ONE sentence — the label, a middot, the settled word lowercase", () => {
    const view = draw(settledGate("continued"));

    const text = (view.container.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("Review \u00b7 continued");
    expect(text).not.toContain("Continued");
  });

  it("draws the word inside the row's own title, never as a badge beside it", () => {
    const view = draw(settledGate("superseded"));

    const settled = view.container.querySelector("[data-rail-gate-settled]");
    expect(settled).not.toBeNull();
    // The word lives INSIDE the row's title, so the two halves cannot wrap apart
    // into the two un-joined spans the eighth proof round measured.
    expect(settled!.closest("h3")).not.toBeNull();
    expect(settled!.textContent).toBe(" \u00b7 superseded");
  });
});
