/**
 * Regression coverage for the SkillsPage scope filter.
 *
 * The page used to filter with a flat `levelFilterOptions` <select> (entries
 * like value:"agent" / value:"workspace" / value:"personal"). That flat level
 * filter was replaced by a hierarchical scope picker: SkillsPage now hands a
 * `scopeValue` + `scopes` vocabulary to <SkillsToolbar> and filters rows via
 * `scopeSelectionMatches` from `@/lib/scope-filter`. These assertions track the
 * current contract (and guard against the dropped flat array creeping back).
 *
 * Source-text assertion (rather than RSC render) because:
 *   1. plugin-pages.tsx is a server component with `cookies()` + DB calls in
 *      transitive paths — full render would require ~200 lines of mocks.
 *   2. The contract under test is structural ("wires the scope picker; carries
 *      the scope-token vocabulary") — statically observable from the source.
 *
 * Positive assertions match CODE-SPECIFIC constructs (a JSX prop, a call, the
 * literal token array, the `isAdmin ? ["admin"]` spread) so a bare token in a
 * comment can't satisfy them — dropping the real code must fail the check.
 * (Comment-stripping this .tsx with a regex is unsafe: inline JSX comment
 * blocks make a naive block-comment strip swallow surrounding code.) The
 * negative guards below assert tokens that are absent from the file entirely
 * — code and
 * comments both — so scanning the raw source cannot false-fail.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

const src = readFileSync(path.join(__dirname, "plugin-pages.tsx"), "utf8");

describe("SkillsPage scope filter", () => {
  it("filters via the hierarchical scope picker wired through SkillsToolbar", () => {
    // Rows are filtered by the multi-scope OR-predicate (cinatra#1074 W5) fed
    // by the ONE canonical `?scope=` parser — both from @/lib/scope-filter —
    // not by a flat `skill.level === levelFilter` comparison.
    expect(src).toMatch(/from\s+["']@\/lib\/scope-filter["']/);
    expect(src).toMatch(/parseScopeFilterParam\(/);
    expect(src).toMatch(/scopeSelectionMatchesAny\(effectiveScopeTokens/);
    // Sortable-header hrefs carry the FULL multi-scope selection.
    expect(src).toMatch(/serializeScopeFilterTokens\(effectiveScopeTokens\)/);
    // The picker itself lives in SkillsToolbar, fed the active scope + vocab,
    // with the admin-only tier gated behind showAdmin.
    expect(src).toMatch(/<SkillsToolbar/);
    expect(src).toMatch(/scopeValue=\{/);
    expect(src).toMatch(/scopes=\{scopes\}/);
    expect(src).toMatch(/showAdmin=\{/);
  });

  it("the raw ?scope= param never bypasses the canonical parser — regression", () => {
    // The pre-W5 single-token reader (`pickSearchParam(resolvedSearchParams.scope)`
    // + a scalar `effectiveScope`) must not creep back; the parser owns
    // splitting, dedupe, accessible-set validation, and the default collapse.
    expect(src).not.toMatch(/pickSearchParam\(resolvedSearchParams\.scope\)/);
    expect(src).toMatch(/parseScopeFilterParam\(\s*resolvedSearchParams\.scope/);
  });

  it("carries the full scope-token vocabulary (personal, workspace, org, team, project, admin)", () => {
    expect(src).toMatch(/\["personal", "workspace"/);
    expect(src).toMatch(/org:\$\{/);
    expect(src).toMatch(/team:\$\{/);
    expect(src).toMatch(/project:\$\{/);
    // The admin tier ("Workspace: Admins only") is spread in only for admins;
    // match the code spread, not a bare "admin" a comment could satisfy.
    expect(src).toMatch(/isAdmin\s*\?\s*\["admin"\]/);
  });

  it("the legacy flat level-filter array (incl. the dropped Agents entry) is gone — regression", () => {
    expect(src).not.toMatch(/levelFilterOptions/);
    expect(src).not.toMatch(/value:\s*"agent"/);
    expect(src).not.toMatch(/label:\s*"Agents"/);
  });

  it("imports ScopeBadge from @/components/scope-badge", () => {
    expect(src).toMatch(/from\s+["']@\/components\/scope-badge["']/);
    expect(src).toMatch(/\bScopeBadge\b/);
  });

  it("inline level-badge span with hardcoded violet palette has been replaced", () => {
    // The inline `border-violet-200 bg-violet-50 text-violet-700` literal must
    // not appear in plugin-pages.tsx anymore; palette ownership lives in ScopeBadge.
    expect(src).not.toMatch(/border-violet-200/);
  });
});
