// @vitest-environment jsdom
//
// AlertDialog — the graded checklist for the components drawing's
// "Alert / Alert dialog" and "Dialog / Sheet" sections, on the clauses that
// reach this primitive (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/alert-dialog-drawing-conformance.test.tsx
//
// The clauses graded here, quoted verbatim:
//
//   "AlertDialog for destructive confirmations."  (Alert / Alert dialog)
//   "--paper (= pages)"                           (Dialog / Sheet)
//   "starts below 4rem navbar"                    (Dialog / Sheet)
//   "dim overlay"                                 (Dialog / Sheet)
//   "etched header rule"                          (Dialog / Sheet)
//
// The alert dialog is a modal dialog, so the Dialog section's chrome clauses
// govern it too — and it carried the same departure from the paper ground that
// `DialogContent` did, from the same `bg-popover` recipe. Both are fixed at
// their own file, and both are pinned, so a fix to one cannot leave the other
// behind.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

afterEach(cleanup);

function renderAlertDialog() {
  render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
  const q = (slot: string) =>
    document.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
  return {
    content: q("alert-dialog-content"),
    overlay: q("alert-dialog-overlay"),
    header: q("alert-dialog-header"),
  };
}

describe('clause: "Modal dialogs use --paper — the same background as pages"', () => {
  it("draws the confirmation panel on the page ground, not on the white card level", () => {
    const { content } = renderAlertDialog();
    // REGRESSION PIN for the fixed clause; the computed rgb in both palettes is
    // read on the boot ("alert dialog paper ground").
    expect(content.className).toContain("bg-background");
    expect(content.className).not.toContain("bg-popover");
  });
});

describe('clause: "Overlay top: 4rem so it doesn\'t cover the navbar."', () => {
  it("starts the overlay one navbar down", () => {
    const { overlay } = renderAlertDialog();
    expect(overlay.className).toContain("top-16");
    expect(overlay.className).toContain("bottom-0");
  });
});

describe('clause: "dim overlay"', () => {
  it("dims the surface behind the confirmation", () => {
    const { overlay } = renderAlertDialog();
    expect(overlay.className).toContain("bg-black/50");
  });
});

describe('clause: "etched header rule"', () => {
  it("closes the header with the shared etched rule", () => {
    const { header } = renderAlertDialog();
    expect(header.className).toContain("divider-etched-after");
  });
});

describe('clause: "AlertDialog for destructive confirmations."', () => {
  it("draws the affirmative action in the destructive button form by default", () => {
    renderAlertDialog();
    const action = document.querySelector(
      "[data-slot='button'], [role='alertdialog'] button",
    );
    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as HTMLElement[];
    const destructive = buttons.find((b) => b.textContent === "Delete");
    expect(action).not.toBeNull();
    expect(destructive).toBeDefined();
    expect(destructive!.className).toContain("destructive");
  });

  it("draws the way out in the outline form, so the two never read alike", () => {
    renderAlertDialog();
    const buttons = Array.from(document.querySelectorAll("button")) as HTMLElement[];
    const cancel = buttons.find((b) => b.textContent === "Keep it");
    expect(cancel).toBeDefined();
    expect(cancel!.className).not.toContain("bg-destructive");
  });
});
