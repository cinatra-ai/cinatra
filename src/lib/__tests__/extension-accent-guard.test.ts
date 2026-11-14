/**
 * Drift guard for the extension accent palette.
 *
 * The seven accent hex codes appear in two places (the runtime palette in
 * `src/lib/extension-accent.ts` and the DB CHECK constraint defined in
 * the accent-color migration script). If anyone changes the palette
 * without updating both, this test catches the runtime side and the
 * migration script's own self-check catches the DB side.
 *
 * Why pin specific hex values: the spec resolutions doc names them. A
 * future palette change is a recorded deviation, not a silent edit.
 */

import { describe, expect, it } from "vitest";
import { contrastAgainst } from "@/lib/color-contrast";
import { ACCENT_PALETTE as SDK_ACCENT_PALETTE } from "../../../packages/sdk-ui/src/lib/extension-accent";
import {
  ACCENT_PALETTE,
  EXTENSION_ACCENTS,
  asExtensionAccent,
  type ExtensionAccent,
} from "@/lib/extension-accent";

describe("extension-accent palette drift guard", () => {
  it("EXTENSION_ACCENTS lists exactly the seven spec categorical colours", () => {
    expect([...EXTENSION_ACCENTS]).toEqual([
      "red",
      "burgundy",
      "green",
      "rust",
      "olive",
      "plum",
      "clay",
    ]);
  });

  it("ACCENT_PALETTE hex codes match the pinned spec categorical tokens", () => {
    // Other six entries retain the existing mapping; clay follows merged design#128
    // and approved app-extensions §IV.3: #a2666d with white foreground.
    expect(ACCENT_PALETTE).toEqual({
      red: { bg: "#a6384f", fg: "#f1f1ed" },
      burgundy: { bg: "#7a2e3a", fg: "#f1f1ed" },
      green: { bg: "#3f6e6b", fg: "#f1f1ed" },
      rust: { bg: "#b0613a", fg: "#f1f1ed" },
      olive: { bg: "#6c6a3a", fg: "#f1f1ed" },
      plum: { bg: "#574a68", fg: "#f1f1ed" },
      clay: { bg: "#a2666d", fg: "#ffffff" },
    });
  });

  it("ACCENT_PALETTE covers every accent in EXTENSION_ACCENTS", () => {
    for (const accent of EXTENSION_ACCENTS) {
      expect(ACCENT_PALETTE[accent as ExtensionAccent]).toBeTruthy();
      expect(ACCENT_PALETTE[accent as ExtensionAccent].bg).toMatch(
        /^#[0-9a-f]{6}$/i,
      );
      expect(ACCENT_PALETTE[accent as ExtensionAccent].fg).toMatch(
        /^#[0-9a-f]{6}$/i,
      );
    }
  });

  it("asExtensionAccent narrows valid strings and rejects invalid ones", () => {
    expect(asExtensionAccent("rust")).toBe("rust");
    expect(asExtensionAccent("plum")).toBe("plum");
    // The three retired pre-reconciliation accents are no longer valid —
    // core__0016 remaps persisted rows (indigo/slate → plum, mustard → rust).
    expect(asExtensionAccent("indigo")).toBeNull();
    expect(asExtensionAccent("mustard")).toBeNull();
    expect(asExtensionAccent("slate")).toBeNull();
    expect(asExtensionAccent("not-a-real-accent")).toBeNull();
    expect(asExtensionAccent(null)).toBeNull();
    expect(asExtensionAccent(undefined)).toBeNull();
    expect(asExtensionAccent("")).toBeNull();
  });
});

// The ratio is a native Source contract, not a browser-painted or palette grade.
describe("rose categorical ground contrast (cinatra#2851)", () => {
  it("carries ordinary text at the 4.5 floor with the approved opaque white pairing", () => {
    const { bg, fg } = ACCENT_PALETTE.clay;
    expect(contrastAgainst(fg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastAgainst(fg, bg)).toBeCloseTo(4.508711, 5);
  });

  it("keeps the public SDK mirror identical without changing accent identity or the other six entries", () => {
    expect(SDK_ACCENT_PALETTE).toEqual(ACCENT_PALETTE);
    expect(SDK_ACCENT_PALETTE.clay).toEqual({ bg: "#a2666d", fg: "#ffffff" });
    expect(Object.keys(ACCENT_PALETTE)).toEqual([...EXTENSION_ACCENTS]);
  });

  it("rejects both the old paper/rose pair and a background-only adoption as below the floor", () => {
    expect(contrastAgainst("#f1f1ed", "#a86b72")).toBeLessThan(4.5);
    expect(contrastAgainst("#f1f1ed", "#a2666d")).toBeLessThan(4.5);
    expect(contrastAgainst("#ffffff", "#a2666d")).toBeGreaterThanOrEqual(4.5);
  });

  it("includes foreground alpha in the reading rather than treating opaque token contrast as painted proof", () => {
    expect(contrastAgainst("rgba(255, 255, 255, 0.9)", "#a2666d")).toBeLessThan(4.5);
  });
});
