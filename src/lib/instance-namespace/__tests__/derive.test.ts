import { describe, it, expect } from "vitest";

import { deriveInstanceNamespace } from "../derive";
import { validateInstanceNamespace } from "../validator";

describe("deriveInstanceNamespace", () => {
  it("slugifies a simple two-word display name", () => {
    expect(deriveInstanceNamespace("ACME Group")).toBe("acme-group");
  });

  it("lowercases and preserves an already-hyphenated name", () => {
    expect(deriveInstanceNamespace("Acme-Group")).toBe("acme-group");
  });

  // Punctuation boundary.
  it("collapses punctuation runs into a single hyphen", () => {
    expect(deriveInstanceNamespace("Acme, Inc.!!")).toBe("acme-inc");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(deriveInstanceNamespace("!!!")).toBe("");
  });

  // Hyphen-normalization boundary.
  it("collapses mixed whitespace/hyphen runs and trims edges", () => {
    expect(deriveInstanceNamespace("  --Multi   Word--Name--  ")).toBe("multi-word-name");
  });

  // Unicode boundary.
  it("folds accented Latin characters to their base letters", () => {
    expect(deriveInstanceNamespace("Café Münchën")).toBe("cafe-munchen");
  });

  it("returns empty string for a display name with no derivable Latin/digit content", () => {
    expect(deriveInstanceNamespace("日本語テスト")).toBe("");
  });

  // Extended combining-mark boundary: U+1AB0 sits in Combining Diacritical
  // Marks Extended, outside the U+0300-U+036F block a
  // fixed-range stripper would cover. Without stripping it, the punctuation
  // collapse step would treat the leftover mark as a separator and produce
  // "a-b" instead of "ab".
  it("strips combining marks outside the common U+0300-U+036F block", () => {
    expect(deriveInstanceNamespace("A᪰B")).toBe("ab");
  });

  // Reserved-string boundary — see reserved-patterns.ts (currently ["cinatra"]).
  it("strips a reserved substring embedded in a longer name", () => {
    expect(deriveInstanceNamespace("Cinatra Corp")).toBe("corp");
    expect(deriveInstanceNamespace("MyCinatraCo")).toBe("my-co");
  });

  it("returns empty string when the whole input IS the reserved word", () => {
    expect(deriveInstanceNamespace("Cinatra")).toBe("");
  });

  // Min-length boundary (format min is 2 chars).
  it("pads a single surviving character up to the 2-character minimum", () => {
    const result = deriveInstanceNamespace("A");
    expect(result).toBe("a0");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty string for a fully empty display name", () => {
    expect(deriveInstanceNamespace("")).toBe("");
  });

  // Max-length boundary (format max is 39 chars).
  it("clamps a very long display name to 39 characters", () => {
    const result = deriveInstanceNamespace("a".repeat(60));
    expect(result.length).toBe(39);
  });

  it("re-trims a hyphen exposed by the max-length clamp", () => {
    // 38 "a" characters + a hyphen land exactly on the 39-char cut boundary,
    // which would otherwise leave a trailing hyphen in the clamped result.
    const displayName = "a".repeat(38) + "-reallylongword";
    const result = deriveInstanceNamespace(displayName);
    expect(result.endsWith("-")).toBe(false);
    expect(result.length).toBeLessThanOrEqual(39);
  });

  // Every non-empty derived candidate must itself pass the shared validator —
  // the derive step aims at validator.ts's target; it never invents a value
  // the single source of truth would then reject.
  it.each([
    "ACME Group",
    "Café Münchën",
    "  --Multi   Word--Name--  ",
    "Cinatra Corp",
    "A",
    "a".repeat(60),
  ])("derived candidate for %j passes validateInstanceNamespace", (displayName) => {
    const candidate = deriveInstanceNamespace(displayName);
    if (candidate === "") return; // honest empty is not itself a claim of validity
    const result = validateInstanceNamespace(candidate);
    expect(result.ok).toBe(true);
  });
});
