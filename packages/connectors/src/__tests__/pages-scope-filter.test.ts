/**
 * Regression coverage for the ConnectorsPage scope filter (multi-scope W5,
 * cinatra#1074) — the /connectors mirror of the SkillsPage structural suite
 * (packages/skills/src/plugin-pages.test.tsx).
 *
 * Source-text assertion (rather than RSC render) for the same reasons as the
 * skills suite: pages.tsx is a server component with auth-session + DB +
 * readiness-probe calls in transitive paths — a full render would need a wall
 * of mocks — while the contract under test ("the raw ?scope= param flows
 * through the ONE canonical parser; rows filter via the OR-predicate") is
 * statically observable from the source. The behavioural halves (the parser,
 * the OR-predicate, the end-to-end pipeline) are covered in
 * src/lib/__tests__/scope-filter.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(__dirname, "..", "pages.tsx"), "utf8");

describe("ConnectorsPage multi-scope filter", () => {
  it("parses ?scope= through the canonical multi-scope parser", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/scope-filter["']/);
    expect(src).toMatch(/parseScopeFilterParam\(\s*resolvedSearchParams\?\.scope/);
    // The parser is fed the actor's accessible-token set (never honor a scope
    // the actor can't see).
    expect(src).toMatch(/accessibleScopeTokens,?\s*\)/);
  });

  it("filters cards via the OR-predicate, with the default-selection short-circuit", () => {
    // The default (broadest) selection shows every visible card — including a
    // connector with NO scope entries — so the short-circuit must stay ahead
    // of the per-entry any-match.
    expect(src).toMatch(/isDefaultScopeSelection\(effectiveScopeTokens\)\s*\|\|/);
    expect(src).toMatch(/scopeSelectionMatchesAny\(effectiveScopeTokens,\s*scopeEntry\)/);
  });

  it("the pre-W5 scalar reader is gone — regression", () => {
    // The single-token reader (`Array.isArray(scopeRaw) ? scopeRaw[0] : …` +
    // a scalar `effectiveScope`) must not creep back.
    expect(src).not.toMatch(/requestedScope/);
    expect(src).not.toMatch(/const\s+effectiveScope\s*=/);
  });

  it("carries the full scope-token vocabulary (personal, workspace, org, team, project, admin)", () => {
    expect(src).toMatch(/\["personal", "workspace", "admin"\]/);
    expect(src).toMatch(/org:\$\{/);
    expect(src).toMatch(/team:\$\{/);
    expect(src).toMatch(/project:\$\{/);
  });
});
