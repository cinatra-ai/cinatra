/**
 * NewAgentPage discovery table regression tests.
 *
 * NewAgentPage lists one row per local template and one row per persisted
 * external template (source_type='external'). The page MUST be a PURE DB READ
 * — no live `fetchExternalAgentCard` call or any other network I/O during
 * render.
 *
 * Run button href scheme:
 *   - external: `/agents/{connector_slug}/{remote_agent_id}/new`
 *   - internal: `buildAgentWorkspacePath(packageName)`
 *
 * Strategy: file-grep assertions (no jsdom/React-render pipeline in this
 * package). Each assertion proves an invariant of the NewAgentPage body — they
 * fail if someone regresses the file to tiles or adds a live card fetch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const pagesPath = path.resolve(__dirname, "..", "pages.tsx");

function readSource() {
  return readFileSync(pagesPath, "utf8");
}

describe("NewAgentPage merged discovery table", () => {
  it("packages/agents/src/pages.tsx exists", () => {
    expect(existsSync(pagesPath)).toBe(true);
  });

  it("exports NewAgentPage", () => {
    expect(readSource()).toMatch(/export\s+(async\s+)?function\s+NewAgentPage/);
  });

  // Merged discovery table.
  it("reads templates from readInstalledAgentTemplates (DB-only source)", () => {
    const source = readSource();
    // At least one call-site inside NewAgentPage body, plus the existing import
    expect(source.match(/readInstalledAgentTemplates\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("filters templates through selectHitlRunVisibleTemplates before rendering", () => {
    const source = readSource();
    expect(source).toMatch(/selectHitlRunVisibleTemplates\s*\(/);
    // Row mapping must consume the filtered set, not the raw input.
    expect(source).toMatch(/visibleTemplates\.map<RowModel>/);
  });

  it("branches rows on sourceType === \"external\"", () => {
    expect(readSource()).toMatch(/sourceType\s*===\s*"external"/);
  });

  // No live network I/O during render.
  it("never imports from @cinatra-ai/a2a for card fetching", () => {
    expect(readSource()).not.toMatch(/from\s+"@cinatra\/a2a"/);
  });

  it("does not call fetchExternalAgentCard during render", () => {
    expect(readSource()).not.toMatch(/fetchExternalAgentCard/);
  });

  it("does not list saved Nango connections during render", () => {
    expect(readSource()).not.toMatch(/listSavedNangoConnections/);
  });

  // Run button href scheme.
  it("builds external runHref as /agents/{connector_slug}/{remote_agent_id}/new", () => {
    const source = readSource();
    // Literal template-string shape using encodeURIComponent on both segments
    expect(source).toMatch(
      /\/agents\/\$\{encodeURIComponent\(t\.connectorSlug\)\}\/\$\{encodeURIComponent\(t\.remoteAgentId\)\}\/new/,
    );
  });

  it("builds local runHref via buildAgentWorkspacePath", () => {
    expect(readSource()).toMatch(/buildAgentWorkspacePath\s*\(/);
  });

  // Copy contract: title pinned, description advertises the HITL filter scope,
  // and empty state copy matches that scope.
  it("ships exact PageHeader copy", () => {
    const source = readSource();
    expect(source).toMatch(/title="Run agent"/);
    expect(source).toMatch(
      /Run an agent with a human-in-the-loop step, one of its sub-agents, or any agent from a connected external A2A server\./,
    );
  });

  it("ships HITL-filter empty-state copy and both CTAs", () => {
    const source = readSource();
    expect(source).toMatch(/No human-in-the-loop agents installed/);
    expect(source).toMatch(
      /Install an agent with review or approval steps from the marketplace, or connect an external A2A server\./,
    );
    expect(source).toMatch(/Browse marketplace/);
    expect(source).toMatch(/Connect A2A server/);
    expect(source).toMatch(/\/configuration\/marketplace/);
    expect(source).toMatch(/\/connectors\?tool=a2a-server/);
    // Empty state must NOT point at the retired in-app registry route.
    expect(source).not.toMatch(/\/agents\/registry/);
    expect(source).not.toMatch(/Open registry/);
  });

  // Icon pinning — Bot only (not Ai which doesn't exist in lucide-react)
  it("uses Bot icon from lucide-react for the Run button", () => {
    const source = readSource();
    expect(source).toMatch(/import\s+\{[^}]*\bBot\b[^}]*\}\s+from\s+"lucide-react"/);
    expect(source).toMatch(/<Bot\s/);
  });

  // Page-shell contract (CLAUDE.md — non-negotiable)
  it("wraps NewAgentPage in the required Main/PageHeader/PageContent shell", () => {
    const source = readSource();
    expect(source.match(/<Main\s/g)?.length ?? 0).toBeGreaterThanOrEqual(2); // AgentsPage + NewAgentPage
    expect(source).toMatch(/<PageHeader\s/);
    expect(source).toMatch(/<PageContent\s/);
  });

  // CSS hygiene — no raw Tailwind palette classes
  it("never uses raw palette classes (bg-white / text-gray-* / bg-slate-*)", () => {
    const source = readSource();
    expect(source).not.toMatch(/className="[^"]*\bbg-white\b/);
    expect(source).not.toMatch(/className="[^"]*\btext-gray-/);
    expect(source).not.toMatch(/className="[^"]*\bbg-slate-/);
  });
});
