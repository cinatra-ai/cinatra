// @vitest-environment jsdom
/**
 * THE RAIL SAYS WHERE THE READER STANDS (cinatra#3149, acceptance item 3).
 *
 * The ratified drawing, `specs/app-artifact-review.html` at design main
 * 033a697c, section I.3:
 *
 *   "The run waits at each — one entry is highlighted at a time — and when a
 *    review is decided the rail keeps it as read-only history and moves to the
 *    next review beneath it (§I)."
 *
 * and section I's own rail sentence, read by the sibling suite next door:
 *
 *   "The step the run is paused on is highlighted; steps already passed sit
 *    above it, steps still to come below."
 *
 * HIGHLIGHTED IS NOT ONLY A COLOUR. Three sibling rails on this same surface
 * already write the position into the DOM — `recommendation-rail-step.tsx:92`,
 * `schedule-rail-step.tsx:119`, `run-surface-rail.tsx:336` all set
 * `aria-current={selected ? "step" : undefined}` on their own active row. This
 * rail — the one the run detail mounts wherever the right pane draws no rail of
 * its own — computed the same fact and wrote it nowhere a reader who does not
 * see colour can reach it. A fourth graded reading of a real run measured the
 * rail with no entry carrying the marker at all.
 *
 * WHAT "ONE AT A TIME" MEANS FOR THE MARKER. The drawing highlights ONE entry,
 * so the marker is a POSITION, not a predicate: a rail carrying two pending
 * gates still stands the reader at the first of them (the one the run is
 * waiting at), and a rail whose every entry is settled stands the reader
 * nowhere at all.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-current-position-marker.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { buildRunStepRail, type RailGate, type RailTemplateStep } from "../run-step-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";

afterEach(() => {
  cleanup();
});

const tstep = (index: number, stepNumber: number, label: string): RailTemplateStep => ({
  index,
  stepNumber,
  label,
});

const gate = (
  reviewTaskId: string,
  status: "pending" | "resolved",
  createdAt: string,
): RailGate => ({
  gateId: `g-${reviewTaskId}`,
  reviewTaskId,
  status,
  disposition: status === "resolved" ? "approved" : null,
  createdAt,
});

/** Mount the rail exactly as the run screen does: the built entries and the
 *  rail's OWN elected anchor, never a hand-picked one. */
function renderRail(input: Parameters<typeof buildRunStepRail>[0]) {
  const rail = buildRunStepRail(input);
  const { container } = render(
    <RunStepRailPanel
      entries={rail.entries}
      activeOrdinal={rail.activeOrdinal}
      reviewHrefBase="/agents/v/p/run-3149/review"
    />,
  );
  return { container, rail };
}

function currentRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[aria-current="step"]'));
}

function labelOf(row: HTMLElement): string {
  return row.querySelector<HTMLElement>('[data-slot="stepper-title"]')?.textContent ?? "";
}

describe("exactly one rail entry carries the current-position marker (cinatra#3149 item 3)", () => {
  it("marks the step the run is paused on, and only that one", () => {
    const { container, rail } = renderRail({
      templateSteps: [
        tstep(1, 10, "Fetched Q3 cohort"),
        tstep(2, 20, "Drafted re-engagement email"),
        tstep(3, 30, "Send sequence"),
      ],
      stepResults: [{ out: "cohort" }],
    });
    expect(rail.activeOrdinal).toBe(2);
    const marked = currentRows(container);
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Drafted re-engagement email");
    expect(marked[0]!.getAttribute("data-rail-kind")).toBe("step");
  });

  it("marks the pending gate the finished run is waiting at", () => {
    const { container, rail } = renderRail({
      templateSteps: [tstep(1, 10, "Drafted the post"), tstep(2, 20, "Drafted the image")],
      stepResults: [{ out: "post" }, { out: "image" }],
      gates: [gate("rt-post", "pending", "2026-09-06T10:00:00.000Z")],
    });
    expect(rail.activeOrdinal).toBe(3);
    const marked = currentRows(container);
    expect(marked.length).toBe(1);
    expect(marked[0]!.getAttribute("data-rail-kind")).toBe("gate");
    expect(marked[0]!.getAttribute("data-rail-status")).toBe("pending");
  });

  it("marks the FIRST of two pending gates — one entry is highlighted at a time", () => {
    const { container } = renderRail({
      templateSteps: [tstep(1, 10, "Drafted the post")],
      stepResults: [{ out: "post" }],
      gates: [
        gate("rt-post", "pending", "2026-09-06T10:00:00.000Z"),
        gate("rt-image", "pending", "2026-09-06T10:05:00.000Z"),
      ],
    });
    const marked = currentRows(container);
    expect(marked.length).toBe(1);
    expect(marked[0]!.querySelector('[data-rail-gate-link="rt-post"]')).not.toBeNull();
  });

  it("marks nothing on a fully resolved rail — the reader stands nowhere", () => {
    const { container, rail } = renderRail({
      templateSteps: [tstep(1, 10, "Drafted the post"), tstep(2, 20, "Drafted the image")],
      stepResults: [{ out: "post" }, { out: "image" }],
      gates: [
        gate("rt-post", "resolved", "2026-09-06T10:00:00.000Z"),
        gate("rt-image", "resolved", "2026-09-06T10:05:00.000Z"),
      ],
    });
    expect(rail.activeOrdinal).toBeNull();
    expect(currentRows(container).length).toBe(0);
  });

  it("keeps the marker on the entry the rail's own anchor names when the rail is renumbered", () => {
    // The schedule step sits above this rail and shifts its numerals
    // (`stepOffset`, cinatra#2788 S9d). The shift moves the numbers, never the
    // position the reader stands at.
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Fetched Q3 cohort"), tstep(2, 20, "Drafted the email")],
      stepResults: [{ out: "cohort" }],
    });
    const { container } = render(
      <RunStepRailPanel
        entries={rail.entries}
        activeOrdinal={rail.activeOrdinal}
        reviewHrefBase="/agents/v/p/run-3149/review"
        stepOffset={1}
      />,
    );
    const marked = currentRows(container);
    expect(marked.length).toBe(1);
    expect(labelOf(marked[0]!)).toBe("Drafted the email");
  });
});
