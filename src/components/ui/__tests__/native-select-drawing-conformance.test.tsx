// @vitest-environment jsdom
//
// NativeSelect — the graded checklist against the components drawing
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/native-select-drawing-conformance.test.tsx
//
// THE DRAWING IS SILENT ON THIS PRIMITIVE, and this file is the record of that
// finding rather than a graded checklist.
//
// The "Select / Dropdown" section names two components — "<Select />,
// <DropdownMenu /> · @/components/ui/select" — and every clause it states is
// about the styled pair: "Trigger mirrors Input chrome. Open popover sits on
// --surface-strong with the same hairline border, slightly higher shadow. Use
// scrollbar-thin on long lists." NativeSelect is the platform `<select>`, which
// has no trigger of its own to chrome and no popover at all — the open list is
// drawn by the operating system and is not addressable from the page.
//
// The component's own source states the same thing from the other side: it
// "deliberately adds NO opinionated default styling" and forwards the call
// site's full className. So there is no clause to grade and nothing to fix;
// what IS graded here is that the primitive stays out of the styled Select's
// way, because a NativeSelect that grew chrome would put two different-looking
// selects in the product against a section that draws one.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { NativeSelect } from "@/components/ui/native-select";

afterEach(cleanup);

function renderNative(className?: string) {
  const { container } = render(
    <NativeSelect aria-label="Scope" className={className}>
      <option value="all">All</option>
      <option value="mine">Mine</option>
    </NativeSelect>,
  );
  return container.querySelector("select") as HTMLSelectElement;
}

describe("the drawing states no clause for this primitive", () => {
  // NOT APPLICABLE, with the reason: the "Select / Dropdown" section's clauses
  // describe a styled trigger and an in-page popover. The platform select has
  // neither — its list is drawn by the OS — so none of them has a seam here.
  it.skip(
    "not applicable: the Select / Dropdown section's clauses (trigger chrome, popover ground, scrollbar-thin) describe the styled pair; the platform select has no trigger and no in-page popover",
    () => {},
  );

  it("adds no chrome of its own, so it cannot contradict a clause it is not covered by", () => {
    // The graded form of "the drawing is silent": the primitive must stay
    // unstyled. A default ground, border or radius appearing here would put a
    // second, ungoverned select chrome into the product.
    const el = renderNative();
    expect(el.className).toBe("");
  });

  it("passes the call site's classes through untouched", () => {
    expect(renderNative("w-full").className).toBe("w-full");
  });
});

describe("it is a real platform select, which is the reason it exists", () => {
  it("renders a native select element rather than a composed widget", () => {
    const el = renderNative();
    expect(el.tagName.toLowerCase()).toBe("select");
    expect(el.querySelectorAll("option")).toHaveLength(2);
  });
});
