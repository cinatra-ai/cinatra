import "server-only";
import { readLocalPackageSkillContent } from "@cinatra-ai/skills";

/**
 * MCP autodiscovery instructions delivered in the `initialize` response.
 *
 * Single source of truth: packages/mcp-server/skills/mcp-autodiscovery/SKILL.md
 * (moved 2026-05-12 from packages/skills-cinatra/skills/mcp-autodiscovery/
 * when the rest of skills-cinatra was archived — this skill is structurally
 * part of the MCP server's discovery contract, not a sales/content skill).
 * The same skill is also exposed to the LLM shell tool's `read_skill` flow,
 * so editing the SKILL.md file updates BOTH paths.
 *
 * Loaded synchronously at module init: async loading would race the first
 * MCP `initialize` request.
 */
export const CINATRA_MCP_INSTRUCTIONS: string = (() => {
  const skillBody = readLocalPackageSkillContent({
    packageDir: "mcp-server",
    skillSlug: "mcp-autodiscovery",
    stripFrontmatter: true,
  });
  if (!skillBody) {
    const msg =
      "[mcp-server] mcp-autodiscovery SKILL.md not found at " +
      "packages/mcp-server/skills/mcp-autodiscovery/SKILL.md — " +
      "MCP initialize.instructions will be empty.";
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
    // eslint-disable-next-line no-console
    console.warn(msg);
  }
  return skillBody ?? "";
})();

/**
 * Experimental capability advertised on `initialize.capabilities.experimental`.
 *
 * Reverse-DNS namespacing (`io.cinatra.protocols`) per MCP spec recommendations.
 * Every sub-object carries at least 1 key (Pitfall 5: io.cinatra.protocols must be
 * Record<string, JSONObject> — never `{}`).
 *
 * Versions verified against codebase + spec sources:
 * - agUi 0.1 (ag-ui-agent-spec is pre-1.0)
 * - a2a  0.3 (codebase already uses @a2a-js/sdk ^0.3.13)
 * - a2ui 0.9 with compatibleVersions: ["0.8"]
 *
 * protocolRevision "2" (cinatra#4141): agUi.endpoint names the per-run SSE
 * stream route (revision 1 named the A2A JSON-RPC endpoint there), and a2ui
 * names the INTERRUPT event's `xRenderer` as the surface key in place of the
 * two compiler authoring fields a client never receives.
 */
export const CINATRA_MCP_EXPERIMENTAL = {
  "io.cinatra.protocols": {
    protocolRevision: "2",
    agUi: {
      version: "0.1",
      specRevision: "2026-03-28",
      specUrl: "https://docs.ag-ui.com",
      transports: ["sse"],
      endpoint: "/api/agents/runs/{runId}/stream",
    },
    a2ui: {
      version: "0.9",
      compatibleVersions: ["0.8"],
      specUrl: "https://a2ui.org",
      surfaceEvent: "INTERRUPT",
      surfaceKeyField: "xRenderer",
      registryEndpoint: "/api/a2ui/surfaces",
    },
    a2a: {
      version: "0.3",
      specUrl: "https://a2aproject.github.io/A2A/",
      agentBaseUrl: "/api/a2a/agents/{vendor}/{slug}",
    },
  },
} satisfies Record<string, object>;
