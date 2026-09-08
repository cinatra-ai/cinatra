// @vitest-environment jsdom
//
// Sheet — the graded checklist for the components drawing's "Dialog / Sheet"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/sheet-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "starts below 4rem navbar"
//   "dim overlay"
//   "etched header rule"
//   "Modal dialogs use --paper — the same background as pages; right-side
//    sheets sit at full-height. Overlay top: 4rem so it doesn't cover the
//    navbar. Dialog header uses an etched paired-line rule for separation."
//
// NO DEPARTURE FOUND, and ONE READING RECORDED rather than acted on — see the
// last block. The section's "--paper" clause is graded on Dialog, in
// dialog-drawing-conformance.test.tsx, where the sentence names it.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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

function renderSheet(side: "right" | "left" | "top" | "bottom" = "right") {
  render(
    <Sheet open>
      <SheetTrigger>Open</SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>Approve drafts</SheetTitle>
        </SheetHeader>
        Twelve drafts pending your read.
      </SheetContent>
    </Sheet>,
  );
  return {
    content: document.querySelector('[data-slot="sheet-content"]') as HTMLElement,
    overlay: document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement,
    header: document.querySelector('[data-slot="sheet-header"]') as HTMLElement,
  };
}

describe('clause: "Overlay top: 4rem so it doesn\'t cover the navbar"', () => {
  it("starts the dim overlay 4rem down, leaving the navbar reachable", () => {
    // `top-16` is 4rem — the clause's value exactly, and the navbar's height.
    const { overlay } = renderSheet();
    expect(overlay.className).toContain("top-16");
    expect(overlay.className).toContain("inset-x-0");
    expect(overlay.className).toContain("bottom-0");
  });
});

describe('clause: "dim overlay"', () => {
  it("dims rather than blanks the surface behind", () => {
    // A dim is a partial alpha; a solid ground would hide the page instead of
    // pushing it back.
    const { overlay } = renderSheet();
    expect(overlay.className).toMatch(/bg-black\/\d+/);
    expect(overlay.className).not.toMatch(/(^|\s)bg-black(\s|$)/);
  });
});

describe('clause: "right-side sheets sit at full-height"', () => {
  it("pins the right sheet to the full height of the area below the navbar", () => {
    // Read together with the overlay clause in the same sentence: the overlay
    // starts at 4rem "so it doesn't cover the navbar", so "full-height" is the
    // full height of the region the overlay covers. The sheet spans it from
    // `top-16` to `bottom-0` with no intrinsic height of its own.
    const { content } = renderSheet("right");
    expect(content.className).toContain("data-[side=right]:top-16");
    expect(content.className).toContain("data-[side=right]:bottom-0");
    expect(content.className).not.toMatch(/data-\[side=right\]:h-/);
  });

  it("gives the left sheet the same treatment, so the pair is symmetrical", () => {
    const { content } = renderSheet("left");
    expect(content.className).toContain("data-[side=left]:top-16");
    expect(content.className).toContain("data-[side=left]:bottom-0");
  });
});

describe('clause: "etched header rule"', () => {
  it("separates the sheet header with the etched paired-line, not a plain border", () => {
    const { header } = renderSheet();
    expect(header.className).toContain("divider-etched-after");
    expect(header.className).not.toMatch(/(^|\s)border-b(\s|$)/);
  });
});

describe("recorded reading, not a departure: the sheet's ground", () => {
  // RECORDED READING. The section's chrome line names "--paper (= pages)", and
  // its prose attaches that token to one of the two components it covers:
  // "MODAL DIALOGS use --paper". The sheet's own sentence in the same section
  // is about height, not ground. The sheet draws `bg-popover`
  // (= --surface-strong), the same ground the drawing gives every other raised
  // panel (Popover, Select's open list, DropdownMenu).
  //
  // Two readings are therefore available — that the chrome line's "--paper"
  // covers both components, or that the prose assigns it to dialogs only — and
  // the drawing does not settle between them. Changing the ground of every
  // sheet in the product is an identity change, so it is written into the
  // record for a reading rather than taken on the stricter of two readings.
  // This follows the disposition this wave already used for the avatar corner.
  it.skip(
    "recorded reading: the section's --paper clause is stated for 'modal dialogs'; whether it also binds the sheet is a question for the drawing, not a fix",
    () => {},
  );

  it("draws the sheet on the same raised-panel ground as the other overlays, whichever reading wins", () => {
    // Passes today. Pinned so the sheet cannot drift to a THIRD ground while
    // the question above is open.
    const { content } = renderSheet();
    expect(content.className).toContain("bg-popover");
  });
});
