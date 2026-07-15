import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Backdrop-by-default contract for the shared modal primitives (cinatra#1500).
//
// Root cause of the reported bug: `DialogContent` rendered its children inside
// `DialogPortal` but NEVER rendered `DialogOverlay`, so a backdrop appeared
// only when a caller remembered to add one by hand. The "Invite a customer"
// dialog (and any other plain `<DialogContent>` caller) therefore opened
// without a dimming scrim. `SheetContent` and `AlertDialogContent` already
// render their overlay by default — `DialogContent` had drifted out of line.
//
// Fix: `DialogContent` renders `<DialogOverlay />` by default, with a
// `showOverlay` opt-out (mirrors the existing `showCloseButton` prop) for the
// rare non-modal caller that manages its own scrim. These source-text
// assertions match the project convention for these Radix wrappers (jsdom
// Radix interaction is brittle; the vitest env here is node — no DOM render)
// and make a re-drop of the overlay a failing test.

const DIALOG_SRC = readFileSync(path.join(__dirname, "dialog.tsx"), "utf8");
const ALERT_SRC = readFileSync(path.join(__dirname, "alert-dialog.tsx"), "utf8");

describe("DialogContent — backdrop by default (cinatra#1500)", () => {
  it("renders DialogOverlay inside the portal by default", () => {
    expect(DIALOG_SRC).toMatch(/\{showOverlay && <DialogOverlay \/>\}/);
  });

  it("defaults showOverlay to true", () => {
    expect(DIALOG_SRC).toMatch(/showOverlay = true/);
  });

  it("exposes showOverlay as a typed opt-out prop", () => {
    expect(DIALOG_SRC).toMatch(/showOverlay\?:\s*boolean/);
  });

  it("renders the overlay before the content element (correct stacking order)", () => {
    const overlayAt = DIALOG_SRC.indexOf("{showOverlay && <DialogOverlay />}");
    const contentAt = DIALOG_SRC.indexOf("<DialogPrimitive.Content");
    expect(overlayAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeLessThan(contentAt);
  });
});

describe("AlertDialogContent — backdrop by default (cinatra#1500)", () => {
  it("renders AlertDialogOverlay inside the portal by default", () => {
    expect(ALERT_SRC).toMatch(/\{showOverlay && <AlertDialogOverlay \/>\}/);
  });

  it("defaults showOverlay to true", () => {
    expect(ALERT_SRC).toMatch(/showOverlay = true/);
  });
});
