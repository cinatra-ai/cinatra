// @vitest-environment jsdom
//
// THE RAIL SAYS WHERE THE READER IS (cinatra#3149 item 3, epic #3023 W5).
//
// THE DEFECT the fourth graded reading measured: "no entry in the rail's DOM
// carries the marker that says which entry is the current one". `RunStepRailPanel`
// computed the "you are here" anchor and read it into `data-rail-status`, but
// wrote `aria-current` nowhere — while three sibling rail components on the same
// run surface (`run-surface-rail.tsx`, `recommendation-rail-step.tsx`,
// `schedule-rail-step.tsx`) all set `aria-current={selected ? "step" : undefined}`
// on their own active row.
//
// THE DRAWING this builds to, quoted: "The run waits at each — ONE ENTRY IS
// HIGHLIGHTED AT A TIME — and when a review is decided the rail keeps it as
// read-only history and moves to the next review beneath it" (§I.3 of the
// ratified review drawing). One entry at a time is the property, so the marker
// is pinned as a COUNT, not as a presence.
//
// SCOPED TO THE DETAIL SELECTION. Every row this panel draws opens the run
// DETAIL (`selection.select("detail")`). When the reader has opened another
// page of the frame instead — the run's own record, which is its own step —
// that page's row is the current one and it already carries the marker itself
// (`run-step-rail-extra-entry.tsx`). So this panel marks its entry only while
// the detail is what is open, and the rail never carries two markers.
//
// Run:
//   npx vitest run --config vitest.config.ts \
//     packages/agents/src/__tests__/run-step-rail-panel.aria-current.test.tsx

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("a", { href, ...rest }, children),
}));

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import { RunStepSelectionContext } from "../run-surface-rail-selection";
import type { RunStepSelection } from "../run-surface-rail-step";

function step(
  key: string,
  ordinal: number,
  status: RunStepRailEntry["status"],
): RunStepRailEntry {
  return { key, ordinal, kind: "step", label: `Step ${ordinal}`, status, sources: ["template"] };
}

function gate(key: string, ordinal: number, resolved: boolean): RunStepRailEntry {
  return {
    key,
    ordinal,
    kind: "gate",
    label: "Review",
    status: resolved ? "resolved" : "pending",
    sources: ["gate"],
    gate: { gateId: `g_${key}`, reviewTaskId: `t_${key}`, disposition: resolved ? "continued" : null, resolved },
  };
}

/** The rail as the frame mounts it, with a selection the reader has made. */
function mount(input: {
  entries: RunStepRailEntry[];
  activeOrdinal: number | null;
  selected?: RunStepSelection;
}) {
  const selection =
    input.selected === undefined
      ? null
      : { selected: input.selected, select: () => {}, canSelect: () => true };
  return render(
    <RunStepSelectionContext.Provider value={selection}>
      <RunStepRailPanel
        entries={input.entries}
        activeOrdinal={input.activeOrdinal}
        reviewHrefBase="/agents/inst_1/runs/run_1"
      />
    </RunStepSelectionContext.Provider>,
  );
}

const marked = (root: HTMLElement) => root.querySelectorAll('[aria-current="step"]');

afterEach(() => cleanup());

describe("the rail marks the current entry, and marks exactly one", () => {
  it("marks the active entry while the run detail is what is open", () => {
    const { container } = mount({
      entries: [step("a", 1, "completed"), step("b", 2, "pending"), step("c", 3, "upcoming")],
      activeOrdinal: 2,
      selected: "detail",
    });
    const current = marked(container);
    expect(current.length).toBe(1);
    expect(current[0]!.textContent).toContain("Step 2");
  });

  it("marks the active entry when that entry is a pending review, not a work step", () => {
    const { container } = mount({
      entries: [step("a", 1, "completed"), gate("g", 2, false), step("c", 3, "upcoming")],
      activeOrdinal: 2,
      selected: "detail",
    });
    const current = marked(container);
    expect(current.length).toBe(1);
    expect(current[0]!.textContent).toContain("Review");
  });

  it("marks nothing on a fully resolved rail — there is no current entry to be on", () => {
    const { container } = mount({
      entries: [step("a", 1, "completed"), gate("g", 2, true), step("c", 3, "completed")],
      activeOrdinal: null,
      selected: "detail",
    });
    expect(marked(container).length).toBe(0);
  });

  it("marks nothing when the reader has opened another page of the frame", () => {
    const { container } = mount({
      entries: [step("a", 1, "completed"), step("b", 2, "pending")],
      activeOrdinal: 2,
      selected: "runMade",
    });
    expect(marked(container).length).toBe(0);
  });

  it("marks nothing outside the run-surface frame, where no page is open at all", () => {
    const { container } = mount({
      entries: [step("a", 1, "completed"), step("b", 2, "pending")],
      activeOrdinal: 2,
    });
    expect(marked(container).length).toBe(0);
  });
});
