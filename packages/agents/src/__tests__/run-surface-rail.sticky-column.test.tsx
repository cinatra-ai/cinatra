// @vitest-environment jsdom
//
// THE RAIL STAYS IN VIEW (cinatra#3080, fix leg 6).
//
// THE DEFECT, MEASURED. On the run page at the settled instant, the sixth
// reading photographed the rail column free of ink — and the rows were in the
// DOM the whole time, at negative viewport offsets (the reading recorded
// "Step 1", "Review · superseded", "Review", "Audit · verified" at y = -268.5,
// -224.5, -184.5 and -144.5). The column had scrolled away with the run detail
// beside it, which on a run whose detail is longer than the window is every
// reading of a settled gate: the gate fills the screen and its own steps are
// above it, out of sight.
//
// WHAT THE DRAWING ASKS FOR. The ratified run-and-review drawing draws the run
// as two columns and keeps the left one where it is: "The surface is a
// two-column frame: a step rail down the left names the run's ordered steps, and
// the run detail on the right shows the selected step"; "The run's step rail
// stays on the left with the gated step highlighted and resolved gates above it
// as history (§I); the gate itself … fills the run detail on the right"; and,
// under its own example, "The reviewer decides in the run, with the steps in
// view." A rail that leaves the window is not a rail the reviewer decides with.
//
// ONE COLUMN, TWO MOUNTS. The frame draws it, and the screen draws it directly
// on the branch that has no gate step to head it. Both take the same classes
// from the one exported constant, so a rail that stays put on one branch and
// scrolls away on the other cannot happen.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/run-surface-rail.sticky-column.test.tsx

import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RUN_SURFACE_RAIL_COLUMN_CLASS, RunSurfaceRail } from "../run-surface-rail";

afterEach(() => cleanup());

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf8",
);

describe("the run surface's rail column", () => {
  it("is sticky, self-aligned and scrollable in itself", () => {
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("sticky");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("top-[calc(var(--banner-height,0px)+5rem)]");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("self-start");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("overflow-y-auto");
    // The column it always was, still: it takes its own width and no more.
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("shrink-0");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("flex-col");
  });

  it("draws the frame's own column with exactly those classes", () => {
    const { container } = render(
      <RunSurfaceRail
        steps={[{ key: "review", row: <span>2 Review</span>, surface: <p>the gate</p> }]}
        rail={<span>3 Review</span>}
        detail={<p>the run detail</p>}
        initialSelection="detail"
      />,
    );
    const column = container.querySelector('[data-conformance-id="run-step-rail-column"]');
    expect(column).not.toBeNull();
    expect(column?.getAttribute("class")).toBe(RUN_SURFACE_RAIL_COLUMN_CLASS);
    // And the rows are still in it, in the order the frame composes them.
    expect(column?.textContent).toBe("2 Review3 Review");
  });

  it("clears the shell's header WHEREVER the shell puts it", () => {
    // The shell's header is `h-16` and sticks at `top: var(--banner-height,0px)`
    // (the impersonation banner sets that variable to a real height while it is
    // up), so a column pinned at a constant 5rem sits under the header exactly
    // when someone is reading the run as somebody else. Both the offset and the
    // height read the same variable the header reads.
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain("var(--banner-height,0px)");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).toContain(
      "max-h-[calc(100vh-var(--banner-height,0px)-6rem)]",
    );
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).not.toContain("top-20");
    expect(RUN_SURFACE_RAIL_COLUMN_CLASS).not.toContain("max-h-[calc(100vh-6rem)]");
  });

  it("gives the screen's own rail-only branch the SAME column", () => {
    // The branch with no gate step composes the column itself; source, because
    // reaching that branch needs a run, a session and a database.
    expect(SCREEN_SRC).toContain("RUN_SURFACE_RAIL_COLUMN_CLASS");
    expect(SCREEN_SRC).not.toMatch(/className="flex shrink-0 flex-col gap-2 pt-1"/);
  });
});
