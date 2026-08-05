/**
 * Source-text conformance for the /artifacts library toolbar (cinatra#2449,
 * spec design@f4489c5d `specs/app-artifacts.html` §I L311–319: "Toolbar:
 * search · facet · scope — no mode control"). The /artifacts mirror of the
 * connectors suite (packages/connectors/src/__tests__/pages-scope-filter.test.ts)
 * plus the multi-select writer contract (scope-filter-combobox-multi.test.tsx).
 *
 * Truths locked here:
 *  - the raw `?scope=` param flows through the ONE canonical multi-scope
 *    parser, fed the actor's accessible-token set (no "admin" — artifacts
 *    carry no admin-only tier);
 *  - rows filter via the OR-predicate with the default-selection
 *    short-circuit, lifted over `artifactScopeEntries`;
 *  - the toolbar mounts the canonical shared <ScopeFilterCombobox> (never a
 *    fork), with the admin row off;
 *  - the dead static "Scope: Workspace" span, the GET form, and the stray
 *    "Apply" submit are gone and stay gone (regression);
 *  - search and facet write the URL through the param-preserving pushWith
 *    (the SkillsToolbar ref pattern), the facet keeping its pinned
 *    conformance/testid contract;
 *  - the page declares and forwards the `scope` search param.
 *
 * The repo runs vitest in a node environment without @testing-library/react,
 * so composition is pinned via source assertions (the established repo
 * pattern — see surface-conformance.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = read("src/app/artifacts/page.tsx");
const MODE = read("src/components/artifacts/library-mode.tsx");
const TOOLBAR = read("src/components/artifacts/library-toolbar.tsx");

describe("LibraryMode multi-scope filter (server half)", () => {
  it("parses ?scope= through the canonical multi-scope parser, fed the accessible-token set", () => {
    expect(MODE).toMatch(/from\s+["']@\/lib\/scope-filter["']/);
    expect(MODE).toMatch(/parseScopeFilterParam\(\s*scopeParam/);
    expect(MODE).toMatch(/accessibleScopeTokens,?\s*\)/);
  });

  it("carries the artifacts token vocabulary — personal/workspace/org/team/project, NO admin", () => {
    expect(MODE).toMatch(/\["personal", "workspace"\]/);
    expect(MODE).toMatch(/org:\$\{/);
    expect(MODE).toMatch(/team:\$\{/);
    expect(MODE).toMatch(/project:\$\{/);
    // Artifacts have no admin-only tier: the accessible set is constructed
    // WITHOUT the admin token (the only place tokens enter the parser).
    expect(MODE).toMatch(/new Set<string>\(\["personal", "workspace"\]\)/);
    expect(MODE).not.toMatch(/accessibleScopeTokens\.add\(["']admin["']\)/);
  });

  it("filters rows via the OR-predicate with the default-selection short-circuit", () => {
    expect(MODE).toMatch(/isDefaultScopeSelection\(effectiveScopeTokens\)/);
    expect(MODE).toMatch(
      /artifactScopeEntries\(a\)\.some\(\(entry\) =>\s*\n\s*scopeSelectionMatchesAny\(effectiveScopeTokens, entry\)/,
    );
  });

  it("a scope-narrowed empty list reads as FILTERED (never the pristine empty state)", () => {
    expect(MODE).toMatch(/filtered=\{Boolean\(q\) \|\| facetActive \|\| scopeActive\}/);
  });

  it("regression — the dead toolbar is gone: no static Scope span, no GET form, no Apply", () => {
    expect(MODE).not.toMatch(/Scope:<\/span>/);
    expect(MODE).not.toMatch(/>\s*Apply\s*</);
    expect(MODE).not.toMatch(/method="get"/);
  });
});

describe("LibraryToolbar (client half) — canonical composition", () => {
  it("mounts the canonical shared ScopeFilterCombobox — never a fork — with the admin row off", () => {
    expect(TOOLBAR).toMatch(
      /import \{ ScopeFilterCombobox \} from "@\/components\/scope-filter-combobox"/,
    );
    expect(TOOLBAR).toMatch(
      /<ScopeFilterCombobox\s*\n\s*id="artifacts-scope-filter"\s*\n\s*value=\{scopeValue\}\s*\n\s*scopes=\{scopes\}\s*\n\s*showAdmin=\{false\}/,
    );
    // No inlined AccessCombobox wiring may creep in beside the shared control.
    expect(TOOLBAR).not.toMatch(/<AccessCombobox/);
  });

  it("composes the shared toolbar primitives: search · facet · scope (§I) with Upload at the right edge", () => {
    expect(TOOLBAR).toMatch(/from "@\/components\/ui\/toolbar"/);
    const searchAt = TOOLBAR.indexOf("<ToolbarSearchInput");
    const facetAt = TOOLBAR.indexOf('data-conformance-id="artifacts-facet"');
    // lastIndexOf: the first occurrence is the import specifier.
    const scopeAt = TOOLBAR.lastIndexOf("<ScopeFilterCombobox");
    const uploadAt = TOOLBAR.indexOf("{uploadAction}");
    expect(searchAt).toBeGreaterThan(-1);
    expect(facetAt).toBeGreaterThan(searchAt);
    expect(scopeAt).toBeGreaterThan(facetAt);
    expect(uploadAt).toBeGreaterThan(scopeAt);
  });

  it("keeps the pinned facet contract (testid + conformance id + action)", () => {
    expect(TOOLBAR).toMatch(/data-testid="artifacts-facet"/);
    expect(TOOLBAR).toMatch(/data-action="filter-facet -> filtered"/);
  });

  it("every filter control carries an explicit accessible name (a11y)", () => {
    // The facet trigger renders only <SelectValue/>, so without an explicit
    // label its accessible name would collapse to the current selection.
    const facetTrigger = TOOLBAR.slice(
      TOOLBAR.indexOf("<SelectTrigger"),
      TOOLBAR.indexOf("</SelectTrigger>"),
    );
    expect(facetTrigger).toMatch(/aria-label="Filter by type"/);
    expect(TOOLBAR).toMatch(/aria-label="Search artifacts"/);
    expect(TOOLBAR).toMatch(/aria-label="Artifacts filters"/);
  });

  it("search and facet write the URL via the param-preserving pushWith (SkillsToolbar ref pattern)", () => {
    expect(TOOLBAR).toMatch(/const searchParamsRef = useRef\(searchParams\?\.toString\(\) \?\? ""\)/);
    expect(TOOLBAR).toMatch(/new URLSearchParams\(searchParamsRef\.current\)/);
    // Optimistic ref advance BEFORE the navigation push.
    const pushWith = TOOLBAR.slice(TOOLBAR.indexOf("function pushWith"));
    expect(pushWith.indexOf("searchParamsRef.current = qs")).toBeGreaterThan(-1);
    expect(pushWith.indexOf("searchParamsRef.current = qs")).toBeLessThan(
      pushWith.indexOf("router.push"),
    );
    // Debounced search → ?q=, dropped when cleared.
    expect(TOOLBAR).toMatch(/pushWith\(\{ q: trimmed \|\| null \}\)/);
    // Facet → ?facet=, dropped for the cleared ("Type: All") selection.
    expect(TOOLBAR).toMatch(/pushWith\(\{ facet: next === ALL_FACETS \? null : next \}\)/);
  });

  it("no Apply step, no form submit — filtering is live", () => {
    expect(TOOLBAR).not.toMatch(/>\s*Apply\s*</);
    expect(TOOLBAR).not.toMatch(/<form/);
    expect(TOOLBAR).not.toMatch(/type="submit"/);
  });
});

describe("the /artifacts page forwards the scope param", () => {
  it("declares ?scope= and passes it through to LibraryMode", () => {
    expect(PAGE).toMatch(/scope\?: string \| string\[\]/);
    expect(PAGE).toMatch(/scopeParam=\{sp\.scope\}/);
  });
});
