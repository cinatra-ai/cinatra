import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Backdrop-by-default contract for the sdk-ui dialog primitive + AppDialog
// (cinatra#1500). The sdk-ui `DialogContent` is a copy of the host primitive
// and must carry the same overlay-by-default behavior + `showOverlay` opt-out.
//
// AppDialog is the one intentional non-modal case: it runs `modal={false}` and
// paints its OWN content-area-only scrim (left-64 keeps the sidebar
// interactive), so it must opt OUT of the default overlay — otherwise it would
// double-dim and cover the sidebar it deliberately leaves live. These
// source-text assertions match the project convention for these Radix wrappers
// (vitest env is node — no DOM render).

const DIALOG_SRC = readFileSync(
  path.join(__dirname, "..", "ui", "dialog.tsx"),
  "utf8",
);
const APP_DIALOG_SRC = readFileSync(
  path.join(__dirname, "..", "app-dialog.tsx"),
  "utf8",
);

describe("sdk-ui DialogContent — backdrop by default (cinatra#1500)", () => {
  it("renders DialogOverlay inside the portal by default", () => {
    expect(DIALOG_SRC).toMatch(/\{showOverlay && <DialogOverlay \/>\}/);
  });

  it("defaults showOverlay to true and exposes it as a typed opt-out", () => {
    expect(DIALOG_SRC).toMatch(/showOverlay = true/);
    expect(DIALOG_SRC).toMatch(/showOverlay\?:\s*boolean/);
  });
});

describe("AppDialog — non-modal opt-out (cinatra#1500)", () => {
  it("stays non-modal (modal={false}) with its own content-area scrim", () => {
    expect(APP_DIALOG_SRC).toMatch(/modal=\{false\}/);
    expect(APP_DIALOG_SRC).toMatch(/createPortal\(/);
    expect(APP_DIALOG_SRC).toMatch(/bg-black\/50/);
  });

  it("opts out of the default DialogContent overlay to avoid a double backdrop", () => {
    expect(APP_DIALOG_SRC).toMatch(/showOverlay=\{false\}/);
  });
});
