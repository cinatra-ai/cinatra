import "server-only";

// Manifest-driven discovery of widget-stream agents. The generated manifest
// (scripts/extensions/generate-extension-manifest.mjs) carries agentSlug-keyed
// entries — a literal dynamic import of the connector's `widget-chat-tool`
// subpath, the factory export name, and the declared stream metadata
// (label/subjectNoun/skillCapability/contextFields/auth) — so the host's
// /api/agents/[agentSlug]/stream route serves any widget-bearing extension
// WITHOUT importing a connector package or branching on slugs. Same posture as
// src/lib/connector-mcp-registration.server.ts: the manifest is the single
// place a connector is named; the host consumes shapes.
//
// FAIL LOUDLY: an entry whose loader cannot be imported, whose recorded factory
// is missing/not a function, or whose factory returns a non-tool shape throws —
// exactly like the static import it replaces. A silently skipped tool would
// turn the widget into a chat-only surface with no failure signal.

import type { LlmFunctionTool } from "@cinatra-ai/llm";
import {
  GENERATED_WIDGET_STREAM_AGENTS,
  type GeneratedWidgetStreamAgentEntry,
} from "@/lib/generated/extensions.server";
import {
  ExtensionModuleAbsentError,
  isDegradedExtensionLoad,
} from "@/lib/extension-load-guard";

export type WidgetStreamAgent = GeneratedWidgetStreamAgentEntry;

/** Resolve a widget-stream agent by its public route slug (null = 404). */
export function resolveWidgetStreamAgent(agentSlug: string): WidgetStreamAgent | null {
  return GENERATED_WIDGET_STREAM_AGENTS[agentSlug] ?? null;
}

/**
 * Import the entry's widget-chat-tool module and build the function tool from
 * the recorded factory. The factory contract is `factory({ context })` →
 * LlmFunctionTool-shaped object (validated structurally here: the route gates
 * its `changes` SSE frame on this tool's `name`).
 */
export async function buildWidgetChatTool(
  agentSlug: string,
  entry: WidgetStreamAgent,
  context: Record<string, unknown>,
): Promise<LlmFunctionTool> {
  const loaded = await entry.load();
  if (isDegradedExtensionLoad(loaded)) {
    // cinatra#7: an absent optional widget-chat-tool module throws the
    // TYPED absent error — the stream route catches it and responds with a
    // defined degraded status (not a generic 500).
    throw new ExtensionModuleAbsentError(loaded.specifier, loaded.reason);
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[widget-stream:${agentSlug}] manifest factory "${entry.factory}" is not an exported function of the widget-chat-tool module`,
    );
  }
  const tool = (factory as (opts: { context: Record<string, unknown> }) => unknown)({ context });
  const candidate = tool as
    | { name?: unknown; description?: unknown; parameters?: unknown; execute?: unknown }
    | null;
  if (
    !candidate ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    typeof candidate.description !== "string" ||
    !candidate.parameters ||
    typeof candidate.parameters !== "object" ||
    typeof candidate.execute !== "function"
  ) {
    throw new Error(
      `[widget-stream:${agentSlug}] factory "${entry.factory}" did not return a function tool ` +
        "(name + description + parameters + execute required)",
    );
  }
  return tool as LlmFunctionTool;
}

// ---------------------------------------------------------------------------
// Content-editor relay targets (cinatra#246).
//
// The widget-stream route is a RELAY, not an LLM: it forwards the user's prompt
// + trusted CMS context to the content-editor agent's A2A endpoint. THAT agent
// is the single LLM with the cinatra MCP server injected, steered by its
// SKILL.md to call the read/update primitives — the host runs no LLM and
// exposes no function tool for this path. `agentPackageName` lets the host
// pre-create the OBO-carrier agent_run (the agent_templates row is keyed by
// package name) so the downstream CMS write authorizes via the real agent-run
// OBO path; `agentUrl` is the WayFlow A2A endpoint (per-connector env override
// with a localhost default, preserving the prior connector behavior).
//
// `agentPackageName` is data-driven from the connector's
// `cinatra.widgetStream.relayAgentPackage` (carried through the generated
// manifest), so the host names NO specific extension instance (core→extension
// instance-coupling ban); `agentUrl` is derived from that package by convention,
// env-overridable per agent.
export type ContentEditorRelayTarget = {
  agentPackageName: string;
  agentUrl: string;
};

/**
 * Per-agent env override key for the relay A2A URL, derived from the slug so no
 * extension-instance literal lives in core. e.g. `wordpress-content-editor` →
 * `CONTENT_EDITOR_A2A_URL__WORDPRESS_CONTENT_EDITOR`.
 */
function relayA2aUrlEnvKey(agentSlug: string): string {
  return `CONTENT_EDITOR_A2A_URL__${agentSlug.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Resolve the relay target (agent package + A2A URL) for a widget slug. The
 * agent package comes from the connector's `cinatra.widgetStream.relayAgentPackage`
 * via the GENERATED manifest — the host never names a specific extension. The
 * A2A URL is derived from that package by convention (the live WayFlow route),
 * env-overridable per agent for dev. Returns null for a slug that is not a
 * relay-bearing widget-stream agent.
 */
export function resolveContentEditorRelay(
  agentSlug: string,
): ContentEditorRelayTarget | null {
  const agentPackageName = resolveWidgetStreamAgent(agentSlug)?.relayAgentPackage;
  if (!agentPackageName) return null;
  // `@scope/name` → `http://localhost:3010/agents/<scope>/<name>/`. The trailing
  // slash is REQUIRED — the A2A SDK card resolver drops the final path segment
  // without it.
  const [scope, name] = agentPackageName.replace(/^@/, "").split("/");
  const defaultUrl = `http://localhost:3010/agents/${scope}/${name}/`;
  return {
    agentPackageName,
    agentUrl: process.env[relayA2aUrlEnvKey(agentSlug)] ?? defaultUrl,
  };
}
