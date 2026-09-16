// @vitest-environment jsdom
//
// Dialog — the graded checklist for the components drawing's "Dialog / Sheet"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/dialog-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "--paper (= pages)"
//   "starts below 4rem navbar"
//   "dim overlay"
//   "etched header rule"
//   "Modal dialogs use --paper — the same background as pages; right-side
//    sheets sit at full-height. Overlay top: 4rem so it doesn't cover the
//    navbar. Dialog header uses an etched paired-line rule for separation."
//
// THE DEPARTURE THIS FILE PINS. The content panel drew `bg-popover`, which
// resolves through `--popover` to `--surface-strong` — white — while the
// clause names `--paper`, the ground the pages themselves are drawn on
// (`--background`). The gap was already visible in the product: the
// marketplace detail modal hand-rolls `bg-background` onto its own
// `DialogContent` with a comment naming the same clause, which is precisely
// the failure class this wave exists to remove — a surface repairing, one
// screen at a time, something the shared primitive should have drawn. The
// primitive now draws the paper ground and that surface's override is
// redundant rather than load-bearing.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

afterEach(cleanup);

function renderDialog() {
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve drafts.</DialogTitle>
          <DialogDescription>Twelve drafts pending your read.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
  const content = document.querySelector(
    '[data-slot="dialog-content"]',
  ) as HTMLElement;
  const overlay = document.querySelector(
    '[data-slot="dialog-overlay"]',
  ) as HTMLElement;
  const header = document.querySelector(
    '[data-slot="dialog-header"]',
  ) as HTMLElement;
  return { content, overlay, header };
}

describe('clause: "Modal dialogs use --paper — the same background as pages"', () => {
  it("draws the content panel on the page ground, not on the white card level", () => {
    const { content } = renderDialog();
    // REGRESSION PIN for the fixed clause. `bg-background` resolves through
    // `--background` to the drawing's `--paper` (#f1f1ed in the light palette);
    // `bg-popover` — the value this replaced — resolves to `--surface-strong`.
    // The computed rgb, in both palettes, is read on the boot
    // ("dialog paper ground", primitive-wave-leg1.spec.ts).
    expect(content.className).toContain("bg-background");
    expect(content.className).not.toContain("bg-popover");
  });

  it("still lets a surface override the ground it inherits", () => {
    render(
      <Dialog open>
        <DialogContent className="bg-card">
          <DialogTitle>Ground override</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overridden = document.querySelectorAll('[data-slot="dialog-content"]');
    const last = overridden[overridden.length - 1] as HTMLElement;
    expect(last.className).toContain("bg-card");
    expect(last.className).not.toContain("bg-background");
  });
});

describe('clause: "Overlay top: 4rem so it doesn\'t cover the navbar."', () => {
  it("starts the overlay one navbar down and runs it to the viewport floor", () => {
    const { overlay } = renderDialog();
    expect(overlay.className).toContain("top-16");
    expect(overlay.className).toContain("bottom-0");
    expect(overlay.className).toContain("inset-x-0");
  });
});

describe('clause: "dim overlay"', () => {
  it("dims the surface behind the dialog rather than blanking it", () => {
    const { overlay } = renderDialog();
    expect(overlay.className).toContain("bg-black/50");
  });

  it("renders the backdrop by default, without the caller asking", () => {
    const { overlay } = renderDialog();
    expect(overlay).not.toBeNull();
  });
});

describe('clause: "Dialog header uses an etched paired-line rule for separation."', () => {
  it("closes the header with the shared etched rule, not a plain border", () => {
    const { header } = renderDialog();
    expect(header.className).toContain("divider-etched-after");
    expect(header.className).not.toContain("border-b");
  });
});

describe('clause: "right-side sheets sit at full-height."', () => {
  // NOT APPLICABLE to this primitive, with the reason: the sentence reads on
  // `SheetContent`, a separate file with its own side geometry. It is graded
  // in this leg's record for `sheet`, not here — grading it against
  // `DialogContent` would assert a rule about a component this file does not
  // render.
  it.skip("not applicable to Dialog: the sentence governs SheetContent's side geometry", () => {});
});
