/**
 * Regression coverage for the /assistants toolbar's scope filter (cinatra#2688)
 * — the /assistants mirror of the /connectors structural suite
 * (packages/connectors/src/__tests__/pages-scope-filter.test.ts).
 *
 * Source-text assertion (rather than an RSC render) for the same reasons as the
 * connectors suite: page.tsx is a server component with auth-session + DB calls
 * in transitive paths, while the contract under test ("the raw ?scope= param
 * flows through the ONE canonical parser against the actor's accessible tokens,
 * and the resolver — not the client — applies it") is statically observable
 * from the source. The behavioural halves are covered in
 * src/lib/__tests__/assistants-directory.test.ts (the fold + the OR-filter),
 * src/lib/__tests__/scope-filter.test.ts (the parser) and the sibling
 * assistants-page-toolbar-behavior.test.tsx (the end-to-end page pipeline).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");

describe("AssistantsDirectoryPage scope filter", () => {
  it("parses ?scope= through the canonical multi-scope parser", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/scope-filter["']/);
    expect(src).toMatch(/parseScopeFilterParam\(\s*resolvedSearchParams\?\.scope/);
    // The parser is fed the actor's accessible-token set (never honor a scope
    // the actor can't see).
    expect(src).toMatch(/accessibleScopeTokens,?\s*\)/);
  });

  it("carries the full scope-token vocabulary (personal, workspace, org, team, project, admin)", () => {
    expect(src).toMatch(/\["personal", "workspace", "admin"\]/);
    expect(src).toMatch(/org:\$\{/);
    expect(src).toMatch(/team:\$\{/);
    expect(src).toMatch(/project:\$\{/);
  });

  it("hands the resolved selection to the RESOLVER, not only to the picker", () => {
    // The server filters; the client only displays the picker. Both halves must
    // be present — a page that passed `scopeValue` but built no `scopeMatch`
    // would render a picker that changes the URL and narrows nothing.
    expect(src).toMatch(/buildAssistantsDirectoryForCurrentActor\(\{\s*scopeMatch:/);
    expect(src).toMatch(/scopeSelectionMatchesAny\(effectiveScopeTokens,\s*entry\)/);
    expect(src).toMatch(/scopeValue=\{effectiveScopeTokens\}/);
  });

  it("short-circuits the default selection by passing NO predicate", () => {
    // The broadest view must keep showing a row that carries no scope entries,
    // so the default selection injects `undefined` rather than a match-all
    // predicate — the /connectors `isDefaultScopeSelection(...) ||` position.
    expect(src).toMatch(
      /isDefaultScopeSelection\(effectiveScopeTokens\)\s*\?\s*undefined\s*:/,
    );
  });

  it("reads the actor's accessible scopes from the active-only UI sibling", () => {
    // cinatra#1942 archive V1, Decision 4: a UI scope picker calls the
    // active-only reader, not the mixed authz/UI one — same as /connectors.
    expect(src).toMatch(/readOrgsWithTeamsForUserActiveOnly/);
    expect(src).toMatch(/readProjectsForUser/);
    expect(src).not.toMatch(/readOrgsWithTeamsForUser\b(?!Active)/);
  });

  it("gates each + Assistant entry on its OWN destination's access", () => {
    expect(src).toMatch(/const canReachMarketplace = isPlatformAdmin\(session\)/);
    expect(src).toMatch(/const canUploadExtension = isPlatformAdmin\(session\)/);
    // Never hardcoded open — that would render a dead action for a non-admin.
    expect(src).not.toMatch(/canReachMarketplace\s*=\s*true/);
    expect(src).not.toMatch(/canUploadExtension\s*=\s*true/);
  });

  it("the pre-#2688 unfiltered call is gone — regression", () => {
    // The bare, argument-less resolver call must not creep back: it would
    // silently ignore ?scope= while the picker kept writing it.
    expect(src).not.toMatch(/buildAssistantsDirectoryForCurrentActor\(\s*\)/);
  });
});
