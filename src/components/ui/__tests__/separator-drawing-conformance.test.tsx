// @vitest-environment jsdom
//
// Separator — the graded checklist for the components drawing's "Separator"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/separator-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "paired-line for sections"
//   "1px low-alpha hairline for rows"
//   "Section breaks use the etched paired-line (the spec's signature divider).
//    It stretches edge-to-edge of the content column by default."
//   "If a tablist is present in the same row, the rule starts immediately to
//    the right of the last tab and runs to the page edge — never overlap a
//    tablist with the rule, and never stack them."
//   "If a toolbar sits below the page header, the toolbar replaces the section
//    rule entirely; never stack both."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Separator } from "@/components/ui/separator";

afterEach(cleanup);

function renderSeparator(props: React.ComponentProps<typeof Separator> = {}) {
  const { container } = render(<Separator {...props} />);
  return container.querySelector('[data-slot="separator"]') as HTMLElement;
}

describe('clause: "1px low-alpha hairline for rows"', () => {
  it("draws the row divider one pixel thick", () => {
    const el = renderSeparator();
    expect(el.className).toContain("data-horizontal:h-px");
  });

  it("paints it from the low-alpha hairline token, not the solid navy", () => {
    // --border resolves to --line = rgba(21, 33, 58, 0.14); --line-strong is
    // the SOLID navy the control borders use. The clause names the low-alpha
    // one. The computed colour is re-read on the boot in both palettes
    // ("separator hairline", primitive-wave-leg1.spec.ts).
    const el = renderSeparator();
    expect(el.className).toContain("bg-border");
    expect(el.className).not.toContain("bg-line-strong");
  });

  it("draws the vertical form one pixel WIDE instead", () => {
    const el = renderSeparator({ orientation: "vertical" });
    expect(el.getAttribute("data-orientation")).toBe("vertical");
    expect(el.className).toContain("data-vertical:w-px");
  });
});

describe('clause: "paired-line for sections" / "the etched paired-line (the spec\'s signature divider)"', () => {
  it("switches to the etched paired-line when the divider is a SECTION break", () => {
    const el = renderSeparator({ major: true });
    expect(el.getAttribute("data-major")).toBe("true");
    expect(el.className).toContain("divider-etched");
  });

  it("drops the single hairline fill when the etched rule takes over", () => {
    // The etched rule paints its own paired lines; leaving `bg-border` on would
    // draw a third line between them.
    const el = renderSeparator({ major: true });
    expect(el.className).toContain("bg-transparent");
  });

  it("keeps the row hairline and the section rule as two distinct forms", () => {
    const row = renderSeparator().className;
    cleanup();
    const section = renderSeparator({ major: true }).className;
    expect(row).not.toContain("divider-etched");
    expect(section).toContain("divider-etched");
  });
});

describe('clause: "It stretches edge-to-edge of the content column by default"', () => {
  it("spans the full width of whatever column it is dropped into", () => {
    expect(renderSeparator().className).toContain("data-horizontal:w-full");
  });
});

describe("the divider is announced as decoration, not as structure", () => {
  it("defaults to decorative so a screen reader does not stop on every rule", () => {
    expect(renderSeparator().getAttribute("role")).not.toBe("separator");
  });
});

describe('clauses about placement beside a tablist or below a toolbar', () => {
  // NOT APPLICABLE at this primitive, with the reason: "the rule starts
  // immediately to the right of the last tab" and "the toolbar replaces the
  // section rule entirely" are COMPOSITION rules — they govern what a surface
  // may place beside or instead of a separator, not what the separator draws.
  // The tablist half is already implemented and graded on Tabs
  // (`TabsListRow`'s `trailingRule`, cinatra#3216); the toolbar half is a
  // surface-level rule with no primitive seam at all.
  it.skip(
    "not applicable at this primitive: the tablist-adjacency rule is graded on TabsListRow (cinatra#3216) and the toolbar-replaces-rule clause has no separator seam",
    () => {},
  );
});
