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
  const ns = (await entry.load()) as Record<string, unknown>;
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
