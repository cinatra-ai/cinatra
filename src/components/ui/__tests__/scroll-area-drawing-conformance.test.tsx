// @vitest-environment jsdom
//
// ScrollArea — the graded checklist for the components drawing's "Scroll area"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/scroll-area-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "6px overlay track"
//   "low-alpha navy thumb"
//   "fades when idle"
//   "no native chrome"
//   "Replaces the OS scrollbar inside scrollable panels — command lists,
//    sidebars, long popovers. A 6px overlay track with a low-alpha navy thumb
//    that fades when idle."
//
// TWO DEPARTURES RECORDED, NOT FIXED — scroll-area is beyond the first ten rows
// of the issue's table. See the two `RECORDED DEPARTURE` blocks.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ScrollArea } from "@/components/ui/scroll-area";

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

function renderArea() {
  // `type="always"` keeps Radix's scrollbar mounted. jsdom measures no layout,
  // so the default ("hover") never decides the content overflows and the bar
  // is never rendered at all — the scrollbar has to be forced into the tree
  // before any of its clauses can be read off it.
  const { container } = render(
    <ScrollArea type="always" className="h-40">
      <div>Run #2,318 · Outreach</div>
      <div>Run #2,317 · Enricher</div>
    </ScrollArea>,
  );
  return {
    root: container.querySelector('[data-slot="scroll-area"]') as HTMLElement,
    viewport: container.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement,
    bar: container.querySelector(
      '[data-slot="scroll-area-scrollbar"]',
    ) as HTMLElement,
    thumb: container.querySelector(
      '[data-slot="scroll-area-thumb"]',
    ) as HTMLElement,
  };
}

describe('clause: "low-alpha navy thumb"', () => {
  // GRADED ON THE BOOT, with the reason. Radix mounts ScrollAreaThumb only
  // after it has measured the viewport, and jsdom performs no layout, so the
  // thumb never enters the tree here however the bar is forced open. Its two
  // clauses — the low-alpha navy fill and the rounded bar shape — are read as
  // computed styles on the live boot in both palettes ("scroll thumb",
  // tests/e2e/design/conformance/primitive-wave-leg1.spec.ts). What this file
  // grades is everything the bar itself carries.
  it.skip(
    "graded on the boot instead: the thumb needs a measured viewport, which jsdom does not provide — see primitive-wave-leg1.spec.ts",
    () => {},
  );

  it("mounts a scrollbar for the thumb to live in", () => {
    expect(renderArea().bar).not.toBeNull();
  });
});

describe('clause: "no native chrome" / "Replaces the OS scrollbar"', () => {
  it("keeps the custom bar out of the pointer and selection path", () => {
    const { bar } = renderArea();
    expect(bar.className).toContain("touch-none");
    expect(bar.className).toContain("select-none");
  });

  it("draws the bar on both axes rather than leaving one to the platform", () => {
    const { bar } = renderArea();
    expect(bar.className).toContain("data-vertical:h-full");
    expect(bar.className).toContain("data-horizontal:flex-col");
  });
});

describe('clause: "overlay track"', () => {
  it("overlays the track on the content instead of reserving a gutter beside it", () => {
    // An overlay bar sits over the viewport; a gutter bar would shrink it. The
    // viewport is full-size, which is what makes the bar an overlay.
    expect(renderArea().viewport.className).toContain("size-full");
  });
});

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "6px overlay track"', () => {
  it("draws the track at the stated 6px", () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table.
    //
    // MEASURED: the vertical bar is `w-2.5` = 10px and the horizontal bar
    // `h-2.5` = 10px, against the 6px the clause names — the track is drawn
    // two-thirds again as wide as the drawing states.
    //
    // FOLLOW-UP: leg 2 takes both axes to `w-1.5` / `h-1.5` (6px). The bar also
    // carries `p-px` and a 1px transparent border, so the visible thumb inside
    // a 6px track lands at 3px; the fix should move the padding with the width
    // and be re-read at the DOM seam rather than assumed from the class.
    const { bar } = renderArea();
    expect(bar.className).toContain("data-vertical:w-1.5");
  });
});

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "fades when idle"', () => {
  it("fades the bar out once scrolling stops", () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table.
    //
    // MEASURED: the scrollbar carries `transition-colors` only. There is no
    // opacity transition and no idle state anywhere in the primitive, so the
    // bar is drawn at full strength permanently. Radix exposes this directly —
    // `ScrollArea.Root` takes `type="scroll"` (show while scrolling, hide after
    // `scrollHideDelay`) — and the primitive passes no `type` at all, so it
    // takes Radix's `"hover"` default and never hides on idle.
    //
    // FOLLOW-UP: leg 2 sets `type="scroll"` on the root with the drawing's idle
    // delay and adds the opacity transition, then re-reads the faded and active
    // states on the boot. This changes behaviour on every scrollable panel in
    // the product, so it wants its own proof round.
    const { bar } = renderArea();
    expect(bar.className).toMatch(/(^|\s)transition-(opacity|\[opacity)/);
  });

  it("carries a transition at all, so the follow-up extends one rather than introducing it", () => {
    // Passes today; recorded alongside the failure as the shape the fix takes.
    expect(renderArea().bar.className).toContain("transition-colors");
  });
});
