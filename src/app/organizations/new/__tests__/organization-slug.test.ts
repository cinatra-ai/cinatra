import { describe, it, expect } from "vitest";

import { toOrganizationSlugBase } from "../organization-slug";

// The dialog-side manual-slug constraint (`^[a-z0-9-]+$`) is looser than this
// pattern; the generated base additionally never leads/trails a hyphen so a
// `-<n>` suffix keeps it well-formed.
const ORG_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe("toOrganizationSlugBase", () => {
  it("slugifies a normal name to a conforming kebab base", () => {
    const slug = toOrganizationSlugBase("UAT Detail Org");
    expect(slug).toBe("uat-detail-org");
    expect(ORG_SLUG_RE.test(slug)).toBe(true);
  });

  it("falls back to 'organization' when the name yields an empty slug (punctuation-only)", () => {
    expect(toOrganizationSlugBase("!!! ???")).toBe("organization");
  });

  it("falls back to 'organization' for a non-latin-only name (slugify strips to empty)", () => {
    expect(toOrganizationSlugBase("日本語")).toBe("organization");
  });

  it("never returns a base longer than 57 chars (room for a -<n> suffix under the 63 cap)", () => {
    const long = "a".repeat(120);
    const slug = toOrganizationSlugBase(long);
    expect(slug.length).toBeLessThanOrEqual(57);
    expect(ORG_SLUG_RE.test(slug)).toBe(true);
  });

  it("a -<n> suffix on the base stays well-formed and within 63 chars", () => {
    const base = toOrganizationSlugBase("a".repeat(120));
    const candidate = `${base}-100`;
    expect(candidate.length).toBeLessThanOrEqual(63);
    expect(ORG_SLUG_RE.test(candidate)).toBe(true);
  });

  it("trims a trailing hyphen left by truncation so the base never ends in '-'", () => {
    // 57th char lands on a hyphen → must be trimmed.
    const slug = toOrganizationSlugBase("word ".repeat(40));
    expect(slug.endsWith("-")).toBe(false);
    expect(ORG_SLUG_RE.test(slug)).toBe(true);
  });
});
