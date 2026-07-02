import { describe, expect, it } from "vitest";

import {
  isTrustedEmbedOrigin,
  parseAllowedEmbedOrigins,
  sanitizeEmbedSection,
  shouldExposeErrorDetails,
} from "@/lib/client-trust";

describe("parseAllowedEmbedOrigins", () => {
  it("returns [] for empty / nullish input", () => {
    expect(parseAllowedEmbedOrigins(undefined)).toEqual([]);
    expect(parseAllowedEmbedOrigins(null)).toEqual([]);
    expect(parseAllowedEmbedOrigins("")).toEqual([]);
    expect(parseAllowedEmbedOrigins("   ")).toEqual([]);
  });

  it("parses a single origin", () => {
    expect(parseAllowedEmbedOrigins("https://a.example")).toEqual([
      "https://a.example",
    ]);
  });

  it("splits on commas and whitespace/newlines", () => {
    expect(
      parseAllowedEmbedOrigins("https://a.example, https://b.example"),
    ).toEqual(["https://a.example", "https://b.example"]);
    expect(
      parseAllowedEmbedOrigins("https://a.example\n https://b.example"),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("canonicalizes each entry to its origin (drops path/trailing slash, lowercases)", () => {
    expect(parseAllowedEmbedOrigins("https://a.example/")).toEqual([
      "https://a.example",
    ]);
    expect(parseAllowedEmbedOrigins("https://a.example/embed/path")).toEqual([
      "https://a.example",
    ]);
    expect(parseAllowedEmbedOrigins("HTTPS://A.EXAMPLE")).toEqual([
      "https://a.example",
    ]);
    expect(parseAllowedEmbedOrigins("https://a.example:8443")).toEqual([
      "https://a.example:8443",
    ]);
  });

  it("drops malformed and schemeless entries rather than trusting them", () => {
    // Bare host (no scheme), whitespace junk, and the literal "null" are all
    // rejected; only the well-formed origin survives.
    expect(
      parseAllowedEmbedOrigins("a.example, not a url, null, https://ok.example"),
    ).toEqual(["https://ok.example"]);
  });

  it("de-duplicates repeated origins", () => {
    expect(
      parseAllowedEmbedOrigins(
        "https://a.example, https://a.example/, https://a.example",
      ),
    ).toEqual(["https://a.example"]);
  });
});

describe("isTrustedEmbedOrigin", () => {
  const allowed = ["https://app.example", "https://parent.example"];

  it("accepts an exact allowlisted origin", () => {
    expect(isTrustedEmbedOrigin("https://parent.example", allowed)).toBe(true);
    expect(isTrustedEmbedOrigin("https://app.example", allowed)).toBe(true);
  });

  it("rejects an origin not on the allowlist", () => {
    expect(isTrustedEmbedOrigin("https://evil.example", allowed)).toBe(false);
  });

  it("rejects lookalike prefixes/suffixes (no substring matching)", () => {
    // A crafted host that merely *contains* an allowlisted origin string must
    // never satisfy the check.
    expect(
      isTrustedEmbedOrigin("https://parent.example.evil.com", allowed),
    ).toBe(false);
    expect(
      isTrustedEmbedOrigin("https://evil.com?x=https://parent.example", allowed),
    ).toBe(false);
    expect(
      isTrustedEmbedOrigin("https://parent.example.", allowed),
    ).toBe(false);
  });

  it("rejects the opaque 'null' origin (sandboxed / data: / file: frames)", () => {
    expect(isTrustedEmbedOrigin("null", allowed)).toBe(false);
  });

  it("rejects empty / undefined origins", () => {
    expect(isTrustedEmbedOrigin("", allowed)).toBe(false);
    expect(isTrustedEmbedOrigin(undefined, allowed)).toBe(false);
    expect(isTrustedEmbedOrigin(null, allowed)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(isTrustedEmbedOrigin("https://app.example", [])).toBe(false);
  });
});

describe("sanitizeEmbedSection", () => {
  it("returns plain identifiers unchanged", () => {
    expect(sanitizeEmbedSection("audience")).toBe("audience");
    expect(sanitizeEmbedSection("step-1_2")).toBe("step-1_2");
    expect(sanitizeEmbedSection("ABC-123_xyz")).toBe("ABC-123_xyz");
  });

  it("returns null for empty / nullish input", () => {
    expect(sanitizeEmbedSection(null)).toBeNull();
    expect(sanitizeEmbedSection(undefined)).toBeNull();
    expect(sanitizeEmbedSection("")).toBeNull();
  });

  it("rejects values that could break out of the <style> selector", () => {
    // Selector-breakout payloads must be neutralized (return null so nothing
    // is interpolated into the inline stylesheet).
    expect(
      sanitizeEmbedSection('x"] { display: block } body { display: none } ['),
    ).toBeNull();
    expect(sanitizeEmbedSection('a"]')).toBeNull();
    expect(sanitizeEmbedSection("a b")).toBeNull();
    expect(sanitizeEmbedSection("a{b}")).toBeNull();
    expect(sanitizeEmbedSection("</style>")).toBeNull();
    expect(sanitizeEmbedSection("a<b")).toBeNull();
    expect(sanitizeEmbedSection("a/*c*/")).toBeNull();
  });

  it("enforces a length bound", () => {
    expect(sanitizeEmbedSection("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitizeEmbedSection("a".repeat(65))).toBeNull();
  });
});

describe("shouldExposeErrorDetails", () => {
  it("suppresses details in production", () => {
    expect(shouldExposeErrorDetails("production")).toBe(false);
  });

  it("exposes details in non-production environments", () => {
    expect(shouldExposeErrorDetails("development")).toBe(true);
    expect(shouldExposeErrorDetails("test")).toBe(true);
    expect(shouldExposeErrorDetails(undefined)).toBe(true);
    expect(shouldExposeErrorDetails("")).toBe(true);
  });
});
