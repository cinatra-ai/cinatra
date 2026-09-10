import { describe, it, expect } from "vitest";

import {
  validateInstanceNamespace,
  canonicalizeInstanceNamespace,
  NAMESPACE_FORMAT_REGEX_SOURCE,
} from "../validator";
// The barrel is the path every consumer imports; pinning it to the same string
// keeps "one export, two consumers" true at the surface the consumers see.
import { NAMESPACE_FORMAT_REGEX_SOURCE as BARREL_NAMESPACE_FORMAT_REGEX_SOURCE } from "..";
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

// -----------------------------------------------------------------------------
// cinatra#3207 — the exported source string is consumed as an HTML `pattern`
// attribute, and a browser compiles a `pattern` value as a regular expression
// with the `v` flag. Under `v` a bare hyphen is a syntax character inside a
// character class, so an unescaped `[a-z0-9-]` is a SyntaxError there and the
// element ends up with no compiled pattern at all — the constraint is silently
// not applied and the browser reports the failure to the console.
//
// Nothing compiled the exported string as a regular expression before this
// block: `validateInstanceNamespace` runs against the flagless literal below
// it, so the two forms could drift without a single test noticing.
// -----------------------------------------------------------------------------
describe("NAMESPACE_FORMAT_REGEX_SOURCE as an HTML pattern attribute", () => {
  it("compiles under the `v` flag a browser applies to a pattern attribute", () => {
    expect(() => new RegExp(NAMESPACE_FORMAT_REGEX_SOURCE, "v")).not.toThrow();
  });

  it("still compiles under `u` and with no flags", () => {
    expect(() => new RegExp(NAMESPACE_FORMAT_REGEX_SOURCE, "u")).not.toThrow();
    expect(() => new RegExp(NAMESPACE_FORMAT_REGEX_SOURCE)).not.toThrow();
  });

  it("is the same string the barrel re-exports (one export, two consumers)", () => {
    expect(BARREL_NAMESPACE_FORMAT_REGEX_SOURCE).toBe(NAMESPACE_FORMAT_REGEX_SOURCE);
  });

  // ALREADY-CANONICAL inputs only: `validateInstanceNamespace` trims and
  // lowercases before it tests, while the attribute tests the raw field value,
  // so casing/whitespace are deliberately out of this parity set (uppercase is
  // asserted against the exported pattern alone, below). None of these inputs
  // carries a reserved substring, so a `false` here is always the FORMAT stage.
  const CANONICAL_FIXTURES = [
    { input: "acme-group", accepted: true },
    { input: "acme", accepted: true },
    { input: "a", accepted: false },
    { input: "a".repeat(40), accepted: false },
    { input: "-acme", accepted: false },
    { input: "acme_group", accepted: false },
  ] as const;

  it.each(CANONICAL_FIXTURES)(
    "the `v`-flag pattern and the server validator agree on $input (accepted: $accepted)",
    ({ input, accepted }) => {
      const compiledUnderV = new RegExp(NAMESPACE_FORMAT_REGEX_SOURCE, "v");
      expect(compiledUnderV.test(input)).toBe(accepted);

      const result = validateInstanceNamespace(input);
      const serverPassesFormat = result.ok || result.error.code !== "format";
      expect(serverPassesFormat).toBe(accepted);
    },
  );

  it("rejects uppercase — the attribute never canonicalizes, the validator does", () => {
    const compiledUnderV = new RegExp(NAMESPACE_FORMAT_REGEX_SOURCE, "v");
    expect(compiledUnderV.test("Acme-Group")).toBe(false);
    // The FUNCTION lowercases first, so it accepts the same input. The two are
    // deliberately different here and are not compared.
    expect(validateInstanceNamespace("Acme-Group").ok).toBe(true);
  });
});
