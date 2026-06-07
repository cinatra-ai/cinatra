import "server-only";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { CINATRA_MCP_INSTRUCTIONS, CINATRA_MCP_EXPERIMENTAL } from "@/lib/mcp-instructions";
import { AG_UI_EVENT_TYPES } from "@cinatra-ai/agent-ui-protocol";
import {
  readAgentTemplateByPackageName,
  readAllTemplateHitlSurfaces,
  isAgentPubliclyDiscoverable,
  type AgentTemplateRecord,
} from "../store";

// Validate manifest cardUrl through the same strict regex the catch-all proxy
// uses (`@vendor/slug` charset). A package_name that does not match
// (uppercase, dot, underscore, traversal char) is unrouteable — emit a
// structured marker rather than a URL the proxy will 502 against.
const PACKAGE_NAME_RE = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

// ---------------------------------------------------------------------------
// AG-UI standard event types — imported from canonical @cinatra-ai/agent-ui-protocol source.
// ---------------------------------------------------------------------------

export { AG_UI_EVENT_TYPES };

// ---------------------------------------------------------------------------
// Static markdown bodies for cinatra://protocols/ag-ui and cinatra://protocols/a2a
// ---------------------------------------------------------------------------

const AG_UI_GUIDE = `# AG-UI Integration Guide — Cinatra MCP Server

## What is AG-UI

AG-UI is the Agent-User Interaction Protocol used by Cinatra agents to stream run progress as
structured events. Spec: https://docs.ag-ui.com — current spec revision 2026-03-28.

## Event types you will encounter

${AG_UI_EVENT_TYPES.join(", ")}

## Event stream URL

\`{CINATRA_BASE_URL}/api/a2a?taskId={runId}\` — SSE stream; events carry an \`ag-ui\` channel header.

## Ordering guarantees

Events are emitted in causal order per run. RUN_STARTED is always first; RUN_FINISHED or
RUN_ERROR is always last. Reconnect by re-issuing the same SSE request — the server replays
from the last delivered event for the given taskId.
`;

const A2A_GUIDE = `# A2A Agent Card Index — Cinatra MCP Server

## What is A2A

Every Cinatra agent is also accessible as an Agent-to-Agent (A2A) peer. Spec:
https://a2aproject.github.io/A2A/. The codebase is on \`@a2a-js/sdk ^0.3.13\` and reports
protocolVersion \`0.3.0\`.

## Endpoint pattern

\`/api/a2a/agents/{vendor}/{slug}\` (GET returns the AgentCard; POST routes JSON-RPC).
The two path segments are derived from the agent's packageName (\`@vendor/slug\`).

## Supported JSON-RPC methods

- \`message/send\` — start a run
- \`message/sendStreaming\` — start a run with SSE event stream
- \`tasks/get\` — fetch task state
- \`tasks/cancel\` — cancel a running task

Use A2A when orchestrating multi-agent workflows from external systems.
`;

// ---------------------------------------------------------------------------
// Dynamic body builder
// ---------------------------------------------------------------------------

export function formatA2uiSurfaceRef(
  rows: Array<{ packageName: string; templateName: string; hitlScreens: string[] }>,
): string {
  if (rows.length === 0) {
    return `# A2UI Surface Reference — Cinatra MCP Server\n\nNo published agent templates with HITL surfaces are currently available.\n`;
  }
  const sections = rows
    .map(
      (r) =>
        `## ${r.packageName} — ${r.templateName}\n\nHITL surfaces:\n` +
        r.hitlScreens.map((s) => `- ${s}`).join("\n"),
    )
    .join("\n\n");
  return `# A2UI Surface Reference — Cinatra MCP Server\n\nSpec: https://a2ui.org\n\nThe \`a2uiSurfaceId\` field on agent JSON nodes identifies the HITL surface a client must render when an agent enters \`pending_approval\` state.\n\n${sections}\n`;
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

type AgentManifest = {
  packageName: string;
  name: string;
  description: string | null;
  type: AgentTemplateRecord["type"];
  hitlScreens: string[];
  protocols: {
    a2a: { cardUrl: string | null; unrouteable?: true; reason?: string };
    agUi: { eventStreamUrl: string; eventTypes: ReadonlyArray<string> };
    a2ui: { surfaceIds: string[] };
  };
};

export function buildAgentManifest(template: AgentTemplateRecord): AgentManifest {
  const surfaces = Array.isArray(template.hitlScreens) ? template.hitlScreens : [];
  const packageName = template.packageName ?? "";

  // Only emit a cardUrl when the package_name is strictly routeable through
  // the catch-all proxy. The proxy at
  // src/app/api/a2a/agents/[...slug]/route.ts calls resolveWayflowUrl, which
  // enforces the same regex below; emitting an unrouteable URL would 502 at
  // request time with no UI signal. Emit a structured "unrouteable" marker
  // so consumers can show a meaningful error.
  const m = PACKAGE_NAME_RE.exec(packageName);
  const a2a: AgentManifest["protocols"]["a2a"] = m
    ? { cardUrl: `/api/a2a/agents/${m[1]}/${m[2]}` }
    : {
        cardUrl: null,
        unrouteable: true,
        reason:
          "packageName does not match the strict @vendor/slug regex " +
          "(/^@([a-z0-9][a-z0-9-]*)\\/([a-z0-9][a-z0-9-]*)$/) and would " +
          "502 against /api/a2a/agents/...",
      };

  return {
    packageName,
    name: template.name,
    description: template.description,
    type: template.type,
    hitlScreens: surfaces,
    protocols: {
      a2a,
      agUi: {
        eventStreamUrl: "/api/a2a?taskId={runId}",
        eventTypes: AG_UI_EVENT_TYPES,
      },
      a2ui: { surfaceIds: surfaces },
    },
  };
}

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

export function registerAgentBuilderDiscovery(server: McpRuntimeToolServer): void {
  // Static AG-UI guide
  server.registerResource(
    "cinatra-protocol-agui",
    "cinatra://protocols/ag-ui",
    {
      title: "AG-UI Integration Guide",
      description: "Event types, ordering, reconnection guidance for the Cinatra MCP server.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        { uri: "cinatra://protocols/ag-ui", text: AG_UI_GUIDE, mimeType: "text/markdown" },
      ],
    }),
  );

  // Dynamic A2UI surface inventory (PUBLISHED templates only — see store.ts)
  server.registerResource(
    "cinatra-protocol-a2ui",
    "cinatra://protocols/a2ui",
    {
      title: "A2UI Surface Reference",
      description:
        "Index of HITL surface IDs declared by all PUBLISHED agent templates. Drafts and archived templates are excluded.",
      mimeType: "text/markdown",
    },
    async () => {
      const rows = await readAllTemplateHitlSurfaces();
      return {
        contents: [
          {
            uri: "cinatra://protocols/a2ui",
            text: formatA2uiSurfaceRef(rows),
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );

  // Static A2A guide
  server.registerResource(
    "cinatra-protocol-a2a",
    "cinatra://protocols/a2a",
    {
      title: "A2A Agent Card Index",
      description: "A2A peer-access pattern for Cinatra agents.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        { uri: "cinatra://protocols/a2a", text: A2A_GUIDE, mimeType: "text/markdown" },
      ],
    }),
  );

  // Templated manifest. The { list: undefined } key is required.
  // NOTE: Because no listCallback is provided, this template appears in
  // `resources/templates/list` ONLY (NOT in `resources/list`) — see vendor
  // index.mjs:1117-1125. Tests verify both lists separately.
  server.registerResource(
    "cinatra-agent-manifest",
    new ResourceTemplate("cinatra://agents/{packageSlug}/manifest", { list: undefined }),
    {
      title: "Agent Manifest",
      description:
        "Denormalized agent JSON with surface IDs, A2A card URL, and AG-UI event types.",
      mimeType: "application/json",
    },
    async (_uri: URL, variables: Record<string, string | string[]>) => {
      const rawSlug = String(variables.packageSlug ?? "").trim();
      if (!rawSlug) return { contents: [] };
      const packageName = rawSlug.startsWith("@") ? rawSlug : `@${rawSlug}`;
      const template = await readAgentTemplateByPackageName(packageName);
      if (!template) return { contents: [] };
      if (template.status !== "published") return { contents: [] };
      // Visibility policy: do not expose a PRIVATE agent's manifest by name
      // through this global discovery resource (closes the by-name discovery path).
      if (!isAgentPubliclyDiscoverable(template)) return { contents: [] };
      // Preserve the requested vendor-prefixed packageName for cardUrl
      // construction. The store may have a normalized form that drops the
      // vendor segment, but the catch-all proxy at /api/a2a/agents/[...slug]
      // expects the original vendor-preserving slug used in the lookup.
      const manifest = buildAgentManifest({ ...template, packageName });
      return {
        contents: [
          {
            uri: `cinatra://agents/${rawSlug}/manifest`,
            text: JSON.stringify(manifest, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  // cinatra/getting-started (slash valid per SEP-986)
  server.registerPrompt(
    "cinatra/getting-started",
    {
      title: "Cinatra — Getting Started",
      description:
        "Re-delivers the AG-UI / A2UI / A2A protocol orientation. Use this if the client truncated the server instructions field.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: CINATRA_MCP_INSTRUCTIONS },
        },
      ],
    }),
  );
}
