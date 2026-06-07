import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "crypto";
// undici fetch is used instead of global fetch to bypass Next.js's patched fetch,
// which would propagate the request-lifecycle AbortSignal and abort long-lived SSE connections.
import { fetch as undiciFetch } from "undici";
import type {
  AddEpisodeInput,
  SearchNodesInput,
  GetEpisodesInput,
  DeleteEpisodeInput,
  ClearGraphInput,
  AddEpisodeResult,
  SearchNodesResult,
  GetEpisodesResult,
  EpisodeNode,
  EntityNode,
} from "./graphiti-types";
import {
  addEpisodeResultSchema,
  searchNodesResultSchema,
  getEpisodesResultSchema,
  graphitiStatusSchema,
} from "./graphiti-types";

const DEFAULT_GRAPHITI_URL = "http://graphiti:8000";

function getGraphitiUrl(): string {
  return process.env.GRAPHITI_URL ?? DEFAULT_GRAPHITI_URL;
}

// ---------------------------------------------------------------------------
// Low-level MCP call — creates a fresh connection per call. This is slightly
// less efficient than a persistent connection but much more reliable in a
// Next.js server context where module-level state is not guaranteed to persist
// across invocations.
// ---------------------------------------------------------------------------
async function callMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const baseUrl = getGraphitiUrl();
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    // Use undici fetch so the connection is not bound to the Next.js request
    // AbortSignal, which would abort SSE streams when the RSC render completes.
    fetch: undiciFetch as unknown as typeof fetch,
    requestInit: { signal: AbortSignal.timeout(30_000) },
  });
  const client = new Client({ name: "cinatra-objects", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    // The SDK's index signature [x: string]: unknown overrides named properties;
    // cast to access content as its actual typed shape.
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const textItem = content.find((c) => c.type === "text");
    if (!textItem || !("text" in textItem) || typeof textItem.text !== "string") {
      throw new Error(`Graphiti ${toolName}: unexpected response format (no text content)`);
    }
    return JSON.parse(textItem.text);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Derive a stable episode UUID from identity hash + group so the same real-
// world entity always maps to the same episode UUID, enabling Graphiti upserts.
// ---------------------------------------------------------------------------
export function identityHashToUuid(identityHash: string, groupId: string): string {
  const hex = createHash("sha256")
    .update(`${groupId}:${identityHash}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function addEpisode(input: AddEpisodeInput): Promise<AddEpisodeResult> {
  // Tool is named "add_memory" in knowledge-graph-mcp 1.0.x (not "add_episode")
  const raw = await callMcp("add_memory", input as Record<string, unknown>);
  return addEpisodeResultSchema.parse(raw);
}

export async function searchNodes(input: SearchNodesInput): Promise<SearchNodesResult> {
  const raw = await callMcp("search_nodes", input as Record<string, unknown>);
  return searchNodesResultSchema.parse(raw);
}

export async function getEpisodes(input: GetEpisodesInput): Promise<GetEpisodesResult> {
  // group_ids is an array; max_episodes replaces last_n
  const raw = await callMcp("get_episodes", input as Record<string, unknown>);
  return getEpisodesResultSchema.parse(raw);
}

export async function deleteEpisode(input: DeleteEpisodeInput): Promise<void> {
  await callMcp("delete_episode", input as Record<string, unknown>);
}

export async function clearGraph(input: ClearGraphInput): Promise<void> {
  await callMcp("clear_graph", input as Record<string, unknown>);
}

export async function getStatus(): Promise<{ status: "connected" | "not_connected"; detail: string }> {
  const url = getGraphitiUrl();
  try {
    const raw = await callMcp("get_status", {});
    const parsed = graphitiStatusSchema.parse(raw);
    return { status: "connected", detail: `Graphiti MCP reachable at ${url}. Status: ${parsed.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "not_connected",
      detail: `Cannot reach Graphiti MCP at ${url}/mcp. Run \`docker compose up graphiti\`. Error: ${msg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Re-exports for handler mapping helpers
// ---------------------------------------------------------------------------
export type { EpisodeNode, EntityNode };
