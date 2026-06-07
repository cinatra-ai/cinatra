import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { toTeamSlugBase } from "../team-slug";

const ACTION_SOURCE = readFileSync("src/app/teams/new/actions.ts", "utf-8");

// CHECK constraint mirror: public.team.team_slug_format.
const TEAM_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe("toTeamSlugBase", () => {
  it("slugifies a normal name to a CHECK-conforming kebab base", () => {
    const slug = toTeamSlugBase("UAT Detail Team");
    expect(slug).toBe("uat-detail-team");
    expect(TEAM_SLUG_RE.test(slug)).toBe(true);
  });

  it("falls back to 'team' when the name yields an empty slug (punctuation-only)", () => {
    expect(toTeamSlugBase("!!! ???")).toBe("team");
  });

  it("falls back to 'team' for a non-latin-only name (slugify strips to empty)", () => {
    expect(toTeamSlugBase("日本語")).toBe("team");
  });

  it("never returns a base longer than 57 chars (room for a -<n> suffix under the 63 cap)", () => {
    const long = "a".repeat(120);
    const slug = toTeamSlugBase(long);
    expect(slug.length).toBeLessThanOrEqual(57);
    expect(TEAM_SLUG_RE.test(slug)).toBe(true);
  });

  it("a -<n> suffix on the base stays CHECK-valid and within 63 chars", () => {
    const base = toTeamSlugBase("a".repeat(120));
    const candidate = `${base}-100`;
    expect(candidate.length).toBeLessThanOrEqual(63);
    expect(TEAM_SLUG_RE.test(candidate)).toBe(true);
  });

  it("trims a trailing hyphen left by truncation so the base never ends in '-'", () => {
    // 57th char lands on a hyphen → must be trimmed (CHECK forbids trailing '-').
    const slug = toTeamSlugBase("word ".repeat(40));
    expect(slug.endsWith("-")).toBe(false);
    expect(TEAM_SLUG_RE.test(slug)).toBe(true);
  });
});

describe("createTeamAction — slug + atomicity contract", () => {
  it("inserts the NOT-NULL slug column into public.team", () => {
    expect(ACTION_SOURCE).toMatch(/INSERT INTO public\.team[\s\S]*\bslug\b/);
  });

  it("allocates the slug race-safely via ON CONFLICT (organizationId, slug) DO NOTHING", () => {
    expect(ACTION_SOURCE).toMatch(/ON CONFLICT \("organizationId", slug\) DO NOTHING/);
    expect(ACTION_SOURCE).toMatch(/RETURNING id/);
  });

  it("derives the slug from toTeamSlugBase", () => {
    expect(ACTION_SOURCE).toMatch(/toTeamSlugBase/);
    expect(ACTION_SOURCE).toMatch(/from\s+"\.\/team-slug"/);
  });

  it("wraps the team + teamMember inserts in a transaction (no orphan team)", () => {
    expect(ACTION_SOURCE).toMatch(/betterAuthDb\.transaction/);
    // teamMember insert lives inside the same write path.
    expect(ACTION_SOURCE).toMatch(/public\."teamMember"/);
  });

  it("keeps redirect() outside the transaction callback", () => {
    // Anchor on the awaited-result consumer (`if (!result.ok)`) rather than the
    // first `});` so a future nested callback can't fool the boundary.
    const txStart = ACTION_SOURCE.indexOf("await betterAuthDb.transaction");
    const txEnd = ACTION_SOURCE.indexOf("if (!result.ok)", txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(txEnd).toBeGreaterThan(txStart);
    const insideTx = ACTION_SOURCE.slice(txStart, txEnd);
    expect(insideTx).not.toMatch(/redirect\(/);
    // The success redirect lives after the transaction completes.
    expect(ACTION_SOURCE.indexOf('redirect("/teams")', txEnd)).toBeGreaterThan(txEnd);
  });
});
