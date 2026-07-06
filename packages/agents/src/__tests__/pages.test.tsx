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
// Agent-run client: card grid + search toolbar extracted from NewAgentPage
// (cinatra#814). Icon and row-type checks read this file instead of pages.tsx.
const agentRunClientPath = path.resolve(__dirname, "..", "agent-run-client.tsx");

function readSource() {
  return readFileSync(pagesPath, "utf8");
}

function readClientSource() {
  return readFileSync(agentRunClientPath, "utf8");
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
    // RowModel is now AgentRunRowModel (exported from agent-run-client for
    // the client component, imported into pages.tsx — cinatra#814).
    expect(source).toMatch(/visibleTemplates\.map<AgentRunRowModel>/);
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

  // Icon pinning (cinatra#1007 / design#25 §VII): the Run button uses the
  // lucide `Play` icon, not the robot icon — the emblem/kind icon (the
  // §VI-derived card's coloured logo tile + byline glyph) still resolves to
  // the "agent" kind emblem (Bot) via the shared extensionKindEmblem helper.
  // Card rendering lives in agent-run-client.tsx (cinatra#814 extraction).
  it("uses the Play icon (not the robot icon) on the Run button", () => {
    const client = readClientSource();
    expect(existsSync(agentRunClientPath)).toBe(true);
    expect(client).toMatch(/import\s+\{[^}]*\bPlay\b[^}]*\}\s+from\s+"lucide-react"/);
    expect(client).toMatch(/<Play\s/);
  });

  it("resolves the card emblem + byline kind-icon via the shared extensionKindEmblem(\"agent\") helper", () => {
    const client = readClientSource();
    expect(client).toMatch(/extensionKindEmblem\("agent"\)/);
    expect(client).toMatch(/extensionKindEmblem\("agent",\s*"size-3\.5"\)/);
  });

  // Design#25 §VII derives the Agent card from §VI minus version +
  // Active/Archived — reuse <InstalledExtensionCard> without those two props,
  // and with the description clamped to 2 lines (not §VI's 3).
  it("renders cards via InstalledExtensionCard without version/status, 2-line description clamp", () => {
    const client = readClientSource();
    expect(client).toMatch(/<InstalledExtensionCard/);
    expect(client).toMatch(/descriptionLineClamp=\{2\}/);
    expect(client).not.toMatch(/\bversion=\{/);
    expect(client).not.toMatch(/\bstatus=\{/);
  });

  // Search toolbar (cinatra#814) — AgentRunClient provides client-side filter.
  it("AgentRunClient renders a ToolbarSearchInput for filter-as-you-type", () => {
    const client = readClientSource();
    // Uses the same ToolbarSearchInput primitive as the marketplace + notifications pages.
    expect(client).toMatch(/ToolbarSearchInput/);
    // Filters on name and description (the two user-visible fields on each card).
    expect(client).toMatch(/\.name\.toLowerCase\(\)/);
    expect(client).toMatch(/\.description\.toLowerCase\(\)/);
  });

  it("NewAgentPage delegates card rendering to AgentRunClient (cinatra#814)", () => {
    const source = readSource();
    expect(source).toMatch(/AgentRunClient/);
    expect(source).toMatch(/rows=\{rows\}/);
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
