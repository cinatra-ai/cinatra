// @vitest-environment jsdom
//
// ToggleGroup — the graded checklist for the components drawing's
// "Toggle / Toggle group" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/toggle-group-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "grouped = hairline divides"
//   "single- or multi-select"
//   "As a single-select group it becomes a segmented control — the canonical
//    way to choose one of two or more options ...; as a multi-select group it
//    toggles several at once."
//   "Either way the buttons share one outer border with hairlines between
//    segments — no gaps, exactly one or any number pressed."
//
// NO DEPARTURE FOUND AT THIS SEAM. The section's "7px radius" clause is carried
// by the shared Toggle base and is recorded as a departure there, in
// toggle-drawing-conformance.test.tsx; this file pins the segment geometry that
// the fix must move together with.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

afterEach(cleanup);

function renderGroup(
  opts: {
    type?: "single" | "multiple";
    spacing?: 0;
    variant?: "default" | "outline";
  } = {},
) {
  const { type = "single", spacing, variant } = opts;
  const common = {
    ...(spacing !== undefined ? { spacing } : {}),
    ...(variant ? { variant } : {}),
  };
  const { container } = render(
    type === "single" ? (
      <ToggleGroup type="single" defaultValue="board" {...common}>
        <ToggleGroupItem value="list">List</ToggleGroupItem>
        <ToggleGroupItem value="board">Board</ToggleGroupItem>
        <ToggleGroupItem value="timeline">Timeline</ToggleGroupItem>
      </ToggleGroup>
    ) : (
      <ToggleGroup type="multiple" defaultValue={["list", "board"]} {...common}>
        <ToggleGroupItem value="list">List</ToggleGroupItem>
        <ToggleGroupItem value="board">Board</ToggleGroupItem>
        <ToggleGroupItem value="timeline">Timeline</ToggleGroupItem>
      </ToggleGroup>
    ),
  );
  return {
    root: container.querySelector('[data-slot="toggle-group"]') as HTMLElement,
    items: Array.from(
      container.querySelectorAll('[data-slot="toggle-group-item"]'),
    ) as HTMLElement[],
  };
}

describe('clause: "single- or multi-select" / "exactly one or any number pressed"', () => {
  it("keeps exactly one segment pressed in the single-select form", () => {
    const { items } = renderGroup({ type: "single" });
    const on = items.filter((i) => i.getAttribute("data-state") === "on");
    expect(on).toHaveLength(1);
  });

  it("allows any number pressed in the multi-select form", () => {
    const { items } = renderGroup({ type: "multiple" });
    const on = items.filter((i) => i.getAttribute("data-state") === "on");
    expect(on).toHaveLength(2);
  });
});

describe('clause: "the buttons share one outer border with hairlines between segments — no gaps"', () => {
  it("closes the gaps between segments when the group is a segmented control", () => {
    // `spacing={0}` is the segmented form; the items lose their individual
    // corners so the group reads as one control.
    const { items } = renderGroup({ spacing: 0 });
    expect(items[1].className).toContain(
      "group-data-[spacing=0]/toggle-group:rounded-none",
    );
  });

  it("re-rounds only the OUTER edges, so one border wraps the whole group", () => {
    const { items } = renderGroup({ spacing: 0 });
    const cls = items[0].className;
    expect(cls).toContain(
      "group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg",
    );
    expect(cls).toContain(
      "group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg",
    );
  });

  it("collapses the doubled strokes between segments to a single hairline", () => {
    // Without this, two adjacent outline segments would draw two 1px borders
    // back to back and the divider would read 2px thick.
    const { items } = renderGroup({ spacing: 0, variant: "outline" });
    const cls = items[1].className;
    expect(cls).toContain(
      "group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0",
    );
    expect(cls).toContain(
      "group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l",
    );
  });

  it("marks the group's spacing on the root so the segment rules can key off it", () => {
    expect(renderGroup({ spacing: 0 }).root.getAttribute("data-spacing")).toBe("0");
  });
});

describe('clause: "hairline divides" — the segment corners the 7px fix must move with', () => {
  it("keeps every segment's corner on ONE radius decision, not two", () => {
    // Recorded for the leg-2 follow-up on the "7px radius" clause (see
    // toggle-drawing-conformance.test.tsx): the group re-states the corner in
    // its own `rounded-l-lg` / `rounded-r-lg` classes, so a fix applied only to
    // the Toggle base would leave the group's ends at 10px while its middle
    // moved to 7px. This assertion is the pin that makes that visible.
    const { items } = renderGroup({ spacing: 0 });
    const outer = items[0].className;
    expect(outer).toMatch(/first:rounded-l-(lg|\[7px\])/);
    expect(outer).toMatch(/last:rounded-r-(lg|\[7px\])/);
  });
});

describe("the group is announced as one control", () => {
  it("exposes a group role with its orientation", () => {
    const { root } = renderGroup();
    expect(root.getAttribute("data-orientation")).toBe("horizontal");
  });
});
