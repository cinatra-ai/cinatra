// @vitest-environment jsdom
/**
 * THE RAIL'S SETTLED ENTRY MARKS ITS STATE THE WAY THE FRAME'S OWN ROWS MARK
 * THEIRS (cinatra#3449, second fix leg).
 *
 * The drawing keeps a decided gate on the rail — specs/app-artifact-review.html
 * §I: "A resolved gate stays on the rail as read-only history — its entry keeps
 * its place and records how it was settled". The frame's own rows already say
 * that in the walk's vocabulary (`data-run-surface-rail-step`, `-reached`,
 * `-settled`, in run-surface-rail.tsx), and this component's own comment states
 * the intent in as many words: "marked the way the frame's own rows mark
 * theirs, so one reading of the rail answers for every row of it".
 *
 * So the extra entry's wrapper -- the one node that stands for the entry, and
 * where its other rail anchors already live -- takes the same three marks, and
 * it takes them exactly once, so a reading of the rail counts the entry once.
 * Nothing DRAWN changes: the label, the settled word, the control and the box
 * are the ones it already had, and this file asserts that beside the new
 * marks.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-step-rail-extra-entry-frame-marks.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Stepper, StepperItem, StepperNav } from "@/components/reui/stepper";

import type { RunStepRailEntry } from "../run-step-rail";
import { RailExtraEntry } from "../run-step-rail-extra-entry";

afterEach(cleanup);

const REVIEW_HREF_BASE = "/agents/vendor/package/instance/review";

const gateEntry = (
  status: RunStepRailEntry["status"],
  over: Partial<RunStepRailEntry["gate"]> = {},
): RunStepRailEntry => ({
  key: `gate:${status}`,
  ordinal: 3,
  kind: "gate",
  label: "Review the post",
  status,
  sources: [],
  gate: {
    gateId: `gate_${status}`,
    reviewTaskId: `task_${status}`,
    disposition: status === "resolved" ? "approved" : null,
    resolved: status === "resolved",
    ...over,
  },
});

/** The entry, read as a rail reading reads it: ONE node per entry -- the ROW
 *  the entry draws, the node that carries the shared row box, never the box and
 *  the control inside it as two. The entry's KIND is read from the node that
 *  carries it, the entry wrapper around that row. */
function row(container: HTMLElement): HTMLElement {
  const marked = container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]");
  expect(marked.length).toBe(1);
  const node = marked[0]!;
  expect(node.closest("[data-rail-kind]")?.getAttribute("data-rail-kind")).toBe("gate");
  return node;
}

function mount(entry: RunStepRailEntry) {
  return render(
    <Stepper value={1} orientation="vertical">
      <StepperNav>
        <StepperItem step={1} completed>
          <RailExtraEntry entry={entry} reviewHrefBase={REVIEW_HREF_BASE} displayStep={1} />
        </StepperItem>
      </StepperNav>
    </Stepper>,
  );
}

describe("§I — a resolved gate keeps its place on the rail, and says so the way every row says it", () => {
  it("marks a resolved review entry reached and settled, its label and settled word untouched", () => {
    const { container } = mount(gateEntry("resolved"));

    const entryRow = row(container);
    expect(entryRow.getAttribute("data-run-surface-rail-step")).toBe("");
    expect(entryRow.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(entryRow.getAttribute("data-run-surface-rail-settled")).toBe("true");
    const wrapper = entryRow.closest<HTMLElement>("[data-rail-kind]");

    // NOTHING DRAWN CHANGES: the entry keeps its place, its label, its settled
    // word and the control it already had.
    expect(wrapper!.getAttribute("data-rail-status")).toBe("resolved");
    expect(wrapper!.getAttribute("data-rail-gate-history")).toBe("true");
    const text = wrapper!.textContent ?? "";
    expect(text).toContain("Review the post");
    expect(text).toContain("approved");
    const link = wrapper!.querySelector<HTMLElement>("[data-rail-gate-link]");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(`${REVIEW_HREF_BASE}/task_resolved`);
  });

  it("marks a pending entry reached but not settled", () => {
    const { container } = mount(gateEntry("pending"));

    const entryRow = row(container);
    expect(entryRow.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(entryRow.getAttribute("data-run-surface-rail-settled")).toBe("false");
  });

  it("marks an upcoming entry neither reached nor settled", () => {
    const { container } = mount(gateEntry("upcoming"));

    const entryRow = row(container);
    expect(entryRow.getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(entryRow.getAttribute("data-run-surface-rail-settled")).toBe("false");
  });

  it("marks a completed entry reached and settled, and a skipped one too", () => {
    const completed = mount({ ...gateEntry("completed") });
    expect(row(completed.container).getAttribute("data-run-surface-rail-settled")).toBe("true");
    cleanup();

    const skipped = mount({ ...gateEntry("skipped") });
    const entryRow = row(skipped.container);
    expect(entryRow.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(entryRow.getAttribute("data-run-surface-rail-settled")).toBe("true");
  });
});
