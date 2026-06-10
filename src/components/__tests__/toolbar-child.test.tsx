/**
 * ToolbarChild — design-system §Nested toolbar (cinatra#54).
 *
 * Covers the spec geometry the component encodes:
 *   - child grounds lighten per level (bg-toolbar-l2 / bg-toolbar-l3)
 *   - 20px inset per level (ml-5 / ml-10) + 6px stack gap (mt-1.5)
 *   - level context scales the embedded primitives (34px → 30px controls,
 *     24px → 22/20px separators) without prop drilling
 *   - the level prop is typed 2 | 3 (the spec's three-level cap is a
 *     compile-time guarantee — asserted via @ts-expect-error)
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Toolbar,
  ToolbarButton,
  ToolbarChild,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarSeparator,
} from "../ui/toolbar";

describe("ToolbarChild", () => {
  it("renders the L2 child ground, inset, and stack gap", () => {
    const html = renderToStaticMarkup(
      <ToolbarChild level={2} aria-label="Sub controls">
        <ToolbarButton active>Active</ToolbarButton>
      </ToolbarChild>,
    );
    expect(html).toContain('data-slot="toolbar-child"');
    expect(html).toContain('data-level="2"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("bg-toolbar-l2");
    expect(html).toContain("ml-5");
    expect(html).toContain("mt-1.5");
    expect(html).toContain("min-h-[42px]");
  });

  it("renders the L3 child one step lighter and 40px from the parent edge", () => {
    const html = renderToStaticMarkup(
      <ToolbarChild level={3} aria-label="Deepest controls">
        <ToolbarButton>Item</ToolbarButton>
      </ToolbarChild>,
    );
    expect(html).toContain('data-level="3"');
    expect(html).toContain("bg-toolbar-l3");
    expect(html).toContain("ml-10");
    expect(html).toContain("min-h-10");
  });

  it("scales embedded controls via the level context (34px in the primary bar, 30px in children)", () => {
    const primary = renderToStaticMarkup(
      <Toolbar>
        <ToolbarButton>Tab</ToolbarButton>
        <ToolbarSeparator />
        <ToolbarSearchGroup>
          <ToolbarSearchInput placeholder="Search…" />
        </ToolbarSearchGroup>
      </Toolbar>,
    );
    expect(primary).toContain("h-[34px]");
    expect(primary).not.toContain("h-[30px]");
    expect(primary).toContain("h-6"); // 24px separator

    const child = renderToStaticMarkup(
      <ToolbarChild level={2} aria-label="Sub controls">
        <ToolbarButton>Tab</ToolbarButton>
        <ToolbarSeparator />
        <ToolbarSearchGroup>
          <ToolbarSearchInput placeholder="Search…" />
        </ToolbarSearchGroup>
      </ToolbarChild>,
    );
    expect(child).toContain("h-[30px]");
    expect(child).not.toContain("h-[34px]");
    expect(child).toContain("h-[22px]"); // 22px separator at L2
  });

  it("keeps the primary toolbar ground untouched", () => {
    const html = renderToStaticMarkup(
      <Toolbar>
        <ToolbarButton>Tab</ToolbarButton>
      </Toolbar>,
    );
    expect(html).toContain("bg-toolbar");
    expect(html).not.toContain("bg-toolbar-l2");
    expect(html).not.toContain("bg-toolbar-l3");
  });

  it("caps nesting at three levels by construction", () => {
    // @ts-expect-error — level 4 is unrepresentable: the spec moves a
    // fourth level into the page body or a sidebar.
    const overdeep = <ToolbarChild level={4} />;
    // @ts-expect-error — level 1 IS the primary <Toolbar>, never a child.
    const underdeep = <ToolbarChild level={1} />;
    expect(overdeep).toBeTruthy();
    expect(underdeep).toBeTruthy();
  });
});
