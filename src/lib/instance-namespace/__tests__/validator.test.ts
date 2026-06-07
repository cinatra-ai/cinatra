import { describe, it, expect } from "vitest";

import { validateInstanceNamespace, canonicalizeInstanceNamespace } from "../validator";
import { RESERVED_SUBSTRINGS } from "../reserved-patterns";

describe("canonicalizeInstanceNamespace", () => {
  it("trims whitespace", () => {
    expect(canonicalizeInstanceNamespace(" acme ")).toBe("acme");
  });
  it("lowercases", () => {
    expect(canonicalizeInstanceNamespace("Acme-Group")).toBe("acme-group");
  });
  it("trims then lowercases", () => {
    expect(canonicalizeInstanceNamespace("  CINATRA-foo  ")).toBe("cinatra-foo");
  });
});

describe("validateInstanceNamespace", () => {
  // Case 1 — required/blank
  it("returns code: required for empty string", () => {
    const result = validateInstanceNamespace("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("required");
      expect(result.canonical).toBe("");
    }
  });

  // Case 1b — required/blank (whitespace only)
  it("returns code: required for whitespace-only input (after trim)", () => {
    const result = validateInstanceNamespace("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("required");
    }
  });

  // Case 2 — format-valid + clean
  it('accepts "acme" (clean lowercase)', () => {
    const result = validateInstanceNamespace("acme");
    expect(result).toEqual({ ok: true, canonical: "acme" });
  });

  // Case 7 — mixed case + clean
  it('accepts "Acme-Group" canonicalized to "acme-group"', () => {
    const result = validateInstanceNamespace("Acme-Group");
    expect(result).toEqual({ ok: true, canonical: "acme-group" });
  });

  // Case 6 — whitespace normalization
  it('accepts " acme " canonicalized to "acme"', () => {
    const result = validateInstanceNamespace(" acme ");
    expect(result).toEqual({ ok: true, canonical: "acme" });
  });

  // Case 3 — format-invalid (special char)
  it('returns code: format for "ACME!" (canonicalized fails regex)', () => {
    const result = validateInstanceNamespace("ACME!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("format");
      expect(result.canonical).toBe("acme!");
      if (result.error.code === "format") {
        expect(result.error.canonical).toBe("acme!");
      }
    }
  });

  // Case 3b — format-invalid (single char — too short)
  it('returns code: format for single-char input "a"', () => {
    const result = validateInstanceNamespace("a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("format");
    }
  });

  // Case 4 — format-valid + reserved-substring
  it('returns code: reserved for "cinatra-clone" with full structured payload', () => {
    const result = validateInstanceNamespace("cinatra-clone");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "reserved") {
      expect(result.error.code).toBe("reserved");
      expect(result.error.canonical).toBe("cinatra-clone");
      expect(result.error.reservedSubstring).toBe("cinatra");
      expect(result.error.contact.channel).toBe("open a GitHub issue at Cinatra-ai/cinatra");
      expect(result.error.contact.href).toBe(
        "https://github.com/Cinatra-ai/cinatra/issues/new?labels=registry-namespace-request"
      );
    }
  });

  // Case 5 — canonicalization (uppercase + reserved) — proves order: canonicalize → format → reserved
  it('returns code: reserved (NOT format) for "CINATRA-foo" → "cinatra-foo"', () => {
    const result = validateInstanceNamespace("CINATRA-foo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("reserved");
      expect(result.canonical).toBe("cinatra-foo");
      if (result.error.code === "reserved") {
        expect(result.error.canonical).toBe("cinatra-foo");
        expect(result.error.reservedSubstring).toBe("cinatra");
      }
    }
  });

  // Case 8 — error-shape contract (no string parsing)
  it("error payload is structured (no message string)", () => {
    const result = validateInstanceNamespace("cinatra-clone");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The validator returns NO `message` field — the verbatim error string is
      // composed at the render layer from this structured payload.
      expect("message" in result.error).toBe(false);
    }
  });

  // Parametrized override of reserved list
  it("respects options.reservedSubstrings override", () => {
    const result = validateInstanceNamespace("acme-bar", { reservedSubstrings: ["bar"] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "reserved") {
      expect(result.error.reservedSubstring).toBe("bar");
    }
  });

  // Sanity: default reserved list comes from the mirror module
  it("defaults to RESERVED_SUBSTRINGS from the mirror module", () => {
    expect(RESERVED_SUBSTRINGS).toEqual(["cinatra"]);
  });

  // Required ordering: required > format > reserved
  it("ordering: blank input never reaches format check", () => {
    const result = validateInstanceNamespace("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("required");
      expect((result.error as { canonical?: string }).canonical).toBeUndefined();
    }
  });
});
