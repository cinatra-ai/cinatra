/**
 * Drift guard for the extension accent palette.
 *
 * The six accent hex codes appear in two places (the runtime palette in
 * `src/lib/extension-accent.ts` and the DB CHECK constraint defined in
 * the accent-color migration script). If anyone changes the palette
 * without updating both, this test catches the runtime side and the
 * migration script's own self-check catches the DB side.
 *
 * Why pin specific hex values: the spec resolutions doc names them. A
 * future palette change is a recorded deviation, not a silent edit.
 */

import { describe, expect, it } from "vitest";
import {
  ACCENT_PALETTE,
  EXTENSION_ACCENTS,
  asExtensionAccent,
  type ExtensionAccent,
} from "@/lib/extension-accent";

describe("extension-accent palette drift guard", () => {
  it("EXTENSION_ACCENTS lists exactly the six spec colours", () => {
    expect([...EXTENSION_ACCENTS]).toEqual([
      "red",
      "burgundy",
      "indigo",
      "green",
      "mustard",
      "slate",
    ]);
  });

  it("ACCENT_PALETTE hex codes match the spec §IV palette", () => {
    expect(ACCENT_PALETTE).toEqual({
      red: { bg: "#a6384f", fg: "#f1f1ed" },
      burgundy: { bg: "#7a2e3a", fg: "#f1f1ed" },
      indigo: { bg: "#364e81", fg: "#f1f1ed" },
      green: { bg: "#3f6e6b", fg: "#f1f1ed" },
      mustard: { bg: "#c79545", fg: "#15213a" },
      slate: { bg: "#5a6477", fg: "#f1f1ed" },
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
    expect(asExtensionAccent("indigo")).toBe("indigo");
    expect(asExtensionAccent("mustard")).toBe("mustard");
    expect(asExtensionAccent("not-a-real-accent")).toBeNull();
    expect(asExtensionAccent(null)).toBeNull();
    expect(asExtensionAccent(undefined)).toBeNull();
    expect(asExtensionAccent("")).toBeNull();
  });
});
