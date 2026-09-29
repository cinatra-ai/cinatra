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
// LEG 2 (this file's current state). Leg 1 recorded two departures here as
// documented expected failures — the 6px track and the idle fade. Leg 2 FIXES
// both in the primitive and retires both records: the two assertions are
// unchanged and now run as plain regression tests. See the two `FIXED IN LEG 2`
// blocks, which keep leg 1's measured reading verbatim.
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
    expect(bar.className).toContain("data-[orientation=vertical]:h-full");
    expect(bar.className).toContain("data-[orientation=horizontal]:flex-col");
  });
});

describe('clause: "overlay track"', () => {
  it("overlays the track on the content instead of reserving a gutter beside it", () => {
    // An overlay bar sits over the viewport; a gutter bar would shrink it. The
    // viewport is full-size, which is what makes the bar an overlay.
    expect(renderArea().viewport.className).toContain("size-full");
  });
});

describe('FIXED IN LEG 2: clause "6px overlay track"', () => {
  // DEPARTURE RETIRED IN LEG 2. Leg 1 recorded this clause as a documented
  // expected failure and spelled out, in the MEASURED and FOLLOW-UP notes
  // below, the exact value the fix had to reach. Leg 2 applies that fix in the
  // primitive itself, so the SAME assertion — unchanged, not relaxed — now runs
  // as a plain regression test: it fails on leg 1's head and passes here, and
  // that is what retires the record. Leg 1's own reading is kept verbatim below
  // so the checklist still says what was wrong and why the value is this one.
  it('FIXED IN LEG 2: draws the track at the stated 6px — clause "6px overlay track"', () => {
    // LEG 1'S READING, KEPT VERBATIM — beyond the first ten rows of issue #3189's table.
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
    expect(bar.className).toContain("data-[orientation=vertical]:w-1.5");
  });

  it("takes the HORIZONTAL axis to the same 6px, so one clause governs both bars", () => {
    // The clause names one track, not a vertical one. Leg 1 measured both axes
    // at `2.5` (10px) and the fix has to move both or the two bars disagree.
    expect(renderArea().bar.className).toContain("data-[orientation=horizontal]:h-1.5");
  });

  it("lets the 6px track hold a 6px thumb rather than a 3px one", () => {
    // Leg 1's follow-up note: "The bar also carries `p-px` and a 1px
    // transparent border, so the visible thumb inside a 6px track lands at 3px;
    // the fix should move the padding with the width."
    //
    // The section's own example draws the thumb itself at 6px
    // (`width: 6px; background: rgba(21,33,58,0.22)`), so the padding and the
    // placeholder border come off with the width change and the track the
    // clause names is the bar the eye sees. Read again at the DOM seam.
    const cls = renderArea().bar.className;
    expect(cls).not.toMatch(/(^|\s)p-px(\s|$)/);
    expect(cls).not.toContain("data-[orientation=vertical]:border-l-transparent");
  });
});

describe('FIXED IN LEG 2: clause "fades when idle"', () => {
  // DEPARTURE RETIRED IN LEG 2. Leg 1 recorded this clause as a documented
  // expected failure and spelled out, in the MEASURED and FOLLOW-UP notes
  // below, the exact value the fix had to reach. Leg 2 applies that fix in the
  // primitive itself, so the SAME assertion — unchanged, not relaxed — now runs
  // as a plain regression test: it fails on leg 1's head and passes here, and
  // that is what retires the record. Leg 1's own reading is kept verbatim below
  // so the checklist still says what was wrong and why the value is this one.
  it('FIXED IN LEG 2: fades the bar out once scrolling stops — clause "fades when idle"', () => {
    // LEG 1'S READING, KEPT VERBATIM — beyond the first ten rows of issue #3189's table.
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

  it("EXTENDS the colour transition rather than replacing it", () => {
    // Leg 1 pinned this as "the shape the fix takes": the bar already carried
    // `transition-colors`, and the fix was to add opacity to it, not to swap
    // one property for the other. `transition-colors` and `transition-opacity`
    // are one tailwind-merge conflict group, so both cannot be written side by
    // side — the two properties are named together in a single arbitrary
    // transition instead, and this case is what keeps colour in it.
    const cls = renderArea().bar.className;
    expect(cls).toContain("transition-[opacity,color]");
  });

  it("carries the enter and exit animation Radix's idle state actually needs", () => {
    // WHY AN ANIMATION AND NOT ONLY A TRANSITION. Leg 1's note named
    // `type="scroll"` as the mechanism, and it is the right one — but with that
    // type Radix does not merely restyle the bar on idle, it UNMOUNTS it behind
    // a `Presence`, and `Presence` waits on an `animationend`, never on a
    // transitionend. A bar carrying only `transition-opacity` would therefore
    // still vanish in one frame: the clause says "fades", so the fade has to be
    // an animation the exit can wait for. Both are kept — the transition covers
    // the states the bar changes in while it is mounted, the animation covers
    // the enter and the exit.
    const cls = renderArea().bar.className;
    expect(cls).toContain("data-[state=visible]:animate-in");
    expect(cls).toContain("data-[state=visible]:fade-in-0");
    expect(cls).toContain("data-[state=hidden]:animate-out");
    expect(cls).toContain("data-[state=hidden]:fade-out-0");
  });

  // THE BEHAVIOUR ITSELF is graded on the boot, for the same reason every
  // measured clause in this wave is: jsdom performs no layout, so Radix never
  // decides the content overflows, the idle state machine never starts, and the
  // bar this file reads only exists at all because `renderArea()` forces it
  // open with `type="always"`. The show-on-scroll / hide-on-idle cycle is read
  // live, in both palettes ("scroll bar fades when idle",
  // tests/e2e/design/conformance/primitive-wave-leg2.spec.ts).
  it.skip(
    "graded on the boot instead: the idle cycle needs a measured viewport and a real scroll — see primitive-wave-leg2.spec.ts",
    () => {},
  );
});
