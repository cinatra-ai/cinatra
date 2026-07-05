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
    // docs@b35fdf4 design-system.html `:root` L31–37.
    expect(ACCENT_PALETTE).toEqual({
      red: { bg: "#a6384f", fg: "#f1f1ed" },
      burgundy: { bg: "#7a2e3a", fg: "#f1f1ed" },
      green: { bg: "#3f6e6b", fg: "#f1f1ed" },
      rust: { bg: "#b0613a", fg: "#f1f1ed" },
      olive: { bg: "#6c6a3a", fg: "#f1f1ed" },
      plum: { bg: "#574a68", fg: "#f1f1ed" },
      clay: { bg: "#a86b72", fg: "#f1f1ed" },
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
