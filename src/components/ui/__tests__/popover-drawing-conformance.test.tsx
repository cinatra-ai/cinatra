// @vitest-environment jsdom
//
// Popover — the graded checklist for the components drawing's
// "Tooltip / Popover" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/popover-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "13-14px popover"
//   "Tooltips are navy with cream type; popovers are surface-strong with navy
//    text. Tooltips read at 12px; popovers at 13-14px."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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

function renderPopover() {
  render(
    <Popover open>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Twelve drafts pending your read.</PopoverContent>
    </Popover>,
  );
  // Portalled, so it is found on the document rather than in the container.
  return document.querySelector('[data-slot="popover-content"]') as HTMLElement;
}

describe('clause: "popovers are surface-strong with navy text"', () => {
  it("grounds the popover on the strong surface, not on the page paper", () => {
    // --popover resolves to --surface-strong, the token the clause names.
    // The computed ground is re-read on the boot in both palettes
    // ("popover ground", primitive-wave-leg1.spec.ts).
    const el = renderPopover();
    expect(el.className).toContain("bg-popover");
    expect(el.className).not.toMatch(/(^|\s)bg-background(\s|$)/);
  });

  it("sets the type in the navy ink that pairs with that ground", () => {
    expect(renderPopover().className).toContain("text-popover-foreground");
  });

  it("is the INVERSE of the tooltip, which is the contrast the clause draws", () => {
    // The section states the two together: the tooltip inverts the page
    // (ink ground, cream type) and the popover does not. Graded as the
    // relation, so the two cannot quietly converge.
    const el = renderPopover();
    expect(el.className).not.toContain("bg-foreground");
    expect(el.className).not.toContain("text-background");
  });
});

describe('clause: "popovers at 13-14px"', () => {
  it("sets the popover type inside the stated band", () => {
    // `text-sm` is 0.875rem = 14px, the top of the band.
    expect(renderPopover().className).toContain("text-sm");
  });
});

describe("the popover reads as a raised panel rather than as page content", () => {
  it("carries a hairline, a corner and a shadow", () => {
    const cls = renderPopover().className;
    expect(cls).toContain("border-line");
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("shadow-md");
  });
});
