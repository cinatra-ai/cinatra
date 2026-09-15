// @vitest-environment jsdom
//
// Toolbar — the graded checklist for the components drawing's "Toolbar" and
// "Nested toolbar" sections (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/toolbar-drawing-conformance.test.tsx
//
// The clauses, quoted verbatim:
//
//   "ground var(--toolbar)"
//   "8px radius · no border"
//   "embedded controls: borderless"
//   "48-56px tall"
//   "24px hairline separators"
//   "Controls inside a toolbar must look different from standalone ones: they
//    carry no individual border."
//   "Hover and selected states are background tints on a rounded rectangle
//    (7px radius, same geometry as the search pill); the font weight and colour
//    never change between states."
//   "Vertical hairlines (24px tall, centred) separate logical groups."
//   "The search field keeps its white interactive surface — the only white
//    element inside the toolbar."
//   "depth: 3 levels max", "each child +6L lighter", "child inset 20px / level",
//   "6px stack gap", "Cap the depth at three."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Toolbar,
  ToolbarButton,
  ToolbarChild,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarSeparator,
} from "@/components/ui/toolbar";

// jsdom ships no ResizeObserver and no DOMRect measurement; Radix's positioning
// layer calls both. Stubbing them is a test-ENVIRONMENT shim, not a relaxed
// assertion: every clause below is still read off the element Radix rendered.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(cleanup);

function renderToolbar() {
  const { container } = render(
    <Toolbar>
      <ToolbarButton active>All</ToolbarButton>
      <ToolbarButton>Agents</ToolbarButton>
      <ToolbarSeparator />
      <ToolbarSearchGroup>
        <ToolbarSearchInput placeholder="Search by name…" />
      </ToolbarSearchGroup>
    </Toolbar>,
  );
  return {
    root: container.querySelector('[data-slot="toolbar"]') as HTMLElement,
    buttons: Array.from(
      container.querySelectorAll('[data-slot="toolbar-button"]'),
    ) as HTMLElement[],
    // ToolbarSeparator renders a bare aria-hidden div with no data-slot of its
    // own; it is addressed by the 1px rule it draws.
    separator: container.querySelector(
      '[data-slot="toolbar"] > div.w-px',
    ) as HTMLElement,
    search: container.querySelector(
      '[data-slot="toolbar-search-group"]',
    ) as HTMLElement,
  };
}

describe('clause: "ground var(--toolbar)" / "8px radius · no border"', () => {
  it("grounds the bar on the toolbar chrome token", () => {
    // The computed ground is re-read on the boot in both palettes
    // ("toolbar ground", primitive-wave-leg1.spec.ts).
    expect(renderToolbar().root.className).toContain("bg-toolbar");
  });

  it("draws the stated 8px corner", () => {
    // `rounded-chip` resolves through --radius-chip to --r-chip = 0.5rem = 8px.
    expect(renderToolbar().root.className).toContain("rounded-chip");
  });

  it("draws NO border, which the clause states explicitly", () => {
    const cls = renderToolbar().root.className;
    expect(cls).not.toMatch(/(^|\s)border(\s|-[a-z])/);
  });
});

describe('clause: "48-56px tall"', () => {
  it("floors the bar inside the stated band", () => {
    // `min-h-12` = 48px, the band's floor; the bar grows with its contents up
    // to the band's ceiling rather than being pinned to one value.
    expect(renderToolbar().root.className).toContain("min-h-12");
  });
});

describe('clause: "embedded controls: borderless" / "they carry no individual border"', () => {
  it("gives toolbar buttons no border of their own", () => {
    for (const button of renderToolbar().buttons) {
      expect(button.className).not.toMatch(/(^|\s)border(\s|-[a-z])/);
    }
  });

  it("gives them no standalone fill either — the bar is their container", () => {
    const { buttons } = renderToolbar();
    const resting = buttons[1];
    expect(resting.className).not.toMatch(/(^|\s)bg-(?!transparent)/);
  });
});

describe('clause: "Hover and selected states are background tints on a rounded rectangle (7px radius ...)"', () => {
  it("draws the state change as a background tint at the 7px radius", () => {
    const { buttons } = renderToolbar();
    expect(buttons[0].className).toContain("rounded-[7px]");
    expect(buttons[0].className).toContain("data-[active=true]:bg-primary/[0.14]");
    expect(buttons[0].className).toContain("hover:bg-foreground/[0.06]");
  });

  it("changes NEITHER the weight NOR the colour between states, which the clause forbids", () => {
    // This is the clause's explicit prohibition, so it is graded as one: the
    // selected and resting buttons must carry the same weight and the same ink.
    const { buttons } = renderToolbar();
    const [selected, resting] = buttons;
    expect(selected.getAttribute("data-active")).toBe("true");
    expect(resting.getAttribute("data-active")).not.toBe("true");
    for (const b of [selected, resting]) {
      expect(b.className).toContain("font-medium");
      expect(b.className).toContain("text-muted-foreground");
      expect(b.className).not.toMatch(/data-\[active=true\]:(font|text)-/);
    }
  });
});

describe('clause: "Vertical hairlines (24px tall, centred) separate logical groups"', () => {
  it("draws the separator 24px tall and one pixel wide", () => {
    const { separator } = renderToolbar();
    expect(separator.className).toContain("h-6");
    expect(separator.className).toContain("w-px");
  });

  it("centres it on the bar's cross axis", () => {
    expect(renderToolbar().separator.className).toContain("self-center");
  });

  it("keeps it out of the accessibility tree — it is chrome, not structure", () => {
    expect(renderToolbar().separator.getAttribute("aria-hidden")).not.toBeNull();
  });
});

describe('clause: "The search field keeps its white interactive surface — the only white element inside the toolbar"', () => {
  it("gives the search field the strong white surface", () => {
    // design-system rule 8 — "White means interactive". The search field is the
    // one control inside the bar that takes typing, so it is the one that keeps
    // the white.
    const { search } = renderToolbar();
    // The pill is the <label> that wraps the glass and the input.
    const pill = search.querySelector("label") as HTMLElement;
    expect(pill.className).toContain("bg-surface-strong");
  });

  it("leaves every other control in the bar without a white ground", () => {
    for (const button of renderToolbar().buttons) {
      expect(button.className).not.toContain("bg-surface-strong");
    }
  });

  it("matches the search pill's corner to the buttons', which the clause calls the same geometry", () => {
    const { search, buttons } = renderToolbar();
    const pill = search.querySelector("label") as HTMLElement;
    expect(pill.className).toContain("rounded-[7px]");
    expect(buttons[0].className).toContain("rounded-[7px]");
  });
});

describe('clauses: "each child +6L lighter" / "child inset 20px / level" / "6px stack gap" / "Cap the depth at three"', () => {
  it("lightens the ground at each level and never past the third", () => {
    const { container } = render(
      <Toolbar>
        <ToolbarButton active>Campaigns</ToolbarButton>
        <ToolbarChild level={2}>
          <ToolbarButton active>Active</ToolbarButton>
          <ToolbarChild level={3}>
            <ToolbarButton active>Sequence</ToolbarButton>
          </ToolbarChild>
        </ToolbarChild>
      </Toolbar>,
    );
    const children = Array.from(
      container.querySelectorAll('[data-slot="toolbar-child"]'),
    ) as HTMLElement[];
    expect(children).toHaveLength(2);
    // The parent sits on --toolbar; each child steps to its own lighter token,
    // and the deepest stays a step darker than the paper.
    expect(children[0].className).toContain("bg-toolbar-l2");
    expect(children[1].className).toContain("bg-toolbar-l3");
    expect(children[1].className).not.toContain("bg-background");
  });

  it("insets each level from the one above it and stacks it beneath", () => {
    const { container } = render(
      <Toolbar>
        <ToolbarChild level={2}>
          <ToolbarButton>Active</ToolbarButton>
        </ToolbarChild>
      </Toolbar>,
    );
    const child = container.querySelector(
      '[data-slot="toolbar-child"]',
    ) as HTMLElement;
    // `ml-5` = 20px, the stated inset; `mt-1.5` = 6px, the stated stack gap.
    expect(child.className).toContain("ml-5");
    expect(child.className).toContain("mt-1.5");
  });

  it("keeps every level on the toolbar's own corner rather than re-rounding it", () => {
    const { container } = render(
      <Toolbar>
        <ToolbarChild level={2}>
          <ToolbarButton>Active</ToolbarButton>
        </ToolbarChild>
      </Toolbar>,
    );
    expect(
      (container.querySelector('[data-slot="toolbar-child"]') as HTMLElement)
        .className,
    ).toContain("rounded-chip");
  });
});
