/**
 * Toolbar contract for the /assistants directory client (cinatra#2688).
 *
 * Source-text assertions, the convention the /connectors toolbar suite uses
 * (packages/connectors/src/__tests__/connectors-client-design.test.ts): the
 * vitest environment is `node`, so a client component is asserted from its
 * source rather than DOM-rendered. What is locked here is the toolbar's
 * COMPOSITION and its permission gating — the two things a later edit could
 * quietly break while every behavioural test stayed green.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.join(__dirname, "..", "assistants-directory-client.tsx"),
  "utf8",
);

describe("AssistantsDirectoryClient — toolbar composition", () => {
  it("reuses the shared toolbar primitives rather than re-styling a bar", () => {
    expect(SRC).toMatch(/from\s+["']@\/components\/ui\/toolbar["']/);
    expect(SRC).toMatch(/<Toolbar aria-label="Assistants filters">/);
    expect(SRC).toMatch(/ToolbarGroup/);
    expect(SRC).toMatch(/ToolbarSeparator/);
  });

  it("reuses the shared ScopeFilterCombobox, server-fed and URL-owning", () => {
    expect(SRC).toMatch(/from\s+["']@\/components\/scope-filter-combobox["']/);
    expect(SRC).toMatch(
      /<ScopeFilterCombobox\s+id="assistants-scope-filter"\s+value=\{scopeValue\}\s+scopes=\{scopes\}\s*\/>/,
    );
  });

  it("carries a THREE-state type filter on the shared ToggleGroup, landing on 'all'", () => {
    expect(SRC).toMatch(/from\s+["']@\/components\/ui\/toggle-group["']/);
    expect(SRC).toMatch(/type FilterType = "all" \| "local" \| "remote"/);
    expect(SRC).toMatch(/useState<FilterType>\("all"\)/);
    expect(SRC).toMatch(/aria-label="Filter by assistant type"/);
    for (const value of ["all", "local", "remote"]) {
      expect(SRC).toMatch(new RegExp(`<ToggleGroupItem\\s+value="${value}"`));
    }
  });

  it("'all' is the PASS-ALL predicate — it narrows nothing", () => {
    expect(SRC).toMatch(/filterType === "all" \? true/);
  });

  it("keeps type / search / sort OUT of the URL — only scope is a URL token", () => {
    // The scope combobox owns `?scope=`; nothing else in this component may
    // write the URL, so a returning reader always lands on the default view.
    expect(SRC).not.toMatch(/useRouter|useSearchParams|router\.(push|replace)/);
  });
});

describe("AssistantsDirectoryClient — the + Assistant affordance", () => {
  it("is a MENU built from the shared dropdown primitive", () => {
    expect(SRC).toMatch(/from\s+["']@\/components\/ui\/dropdown-menu["']/);
    expect(SRC).toMatch(/<Plus data-icon="inline-start" aria-hidden="true" \/>\s*\n\s*Assistant/);
  });

  it("renders only when at least one acquisition path is reachable", () => {
    expect(SRC).toMatch(/const showAddMenu = canReachMarketplace \|\| canUploadExtension/);
    // The leading divider rides inside the same branch, so a hidden action
    // never leaves a doubled hairline behind it.
    expect(SRC).toMatch(/\{showAddMenu \? \(\s*<>\s*<ToolbarSeparator \/>\s*<ToolbarGroup>/);
  });

  it("gates each entry on its OWN destination and never hardcodes access open", () => {
    expect(SRC).toMatch(
      /\{canReachMarketplace \? \([\s\S]*?href="\/configuration\/marketplace\?tab=agent"/,
    );
    expect(SRC).toMatch(
      /\{canUploadExtension \? \([\s\S]*?href="\/configuration\/extensions\/upload"/,
    );
    expect(SRC).toMatch(/canReachMarketplace: boolean;/);
    expect(SRC).toMatch(/canUploadExtension: boolean;/);
    expect(SRC).not.toMatch(/canReachMarketplace\s*=\s*true/);
    expect(SRC).not.toMatch(/canUploadExtension\s*=\s*true/);
  });

  it("offers NO agent-builder create entry — the builder cannot produce an assistant", () => {
    // The builder's create path always writes agent_kind='executor' (the
    // assistant kind is set by the install seam), so a "Create" entry would be
    // a dead path. Locked as a regression: no chat create-agent link here.
    expect(SRC).not.toMatch(/mode=create-agent/);
    expect(SRC).not.toMatch(/\/agents\/builder/);
  });
});

describe("AssistantsDirectoryClient — the empty state", () => {
  it("keys off the SERVER-resolved rows, never the search-narrowed list", () => {
    // A query that matches nothing must leave a bare list, not a panel
    // asserting that nothing is available.
    expect(SRC).toMatch(/rows\.length === 0 \?/);
    expect(SRC).not.toMatch(/visibleRows\.length === 0 \?/);
  });

  it("names scope and visibility as causes, not just 'nothing installed'", () => {
    expect(SRC).toMatch(/outside the scope you have selected/);
    expect(SRC).toMatch(/outside what you are allowed to see/);
  });
});
