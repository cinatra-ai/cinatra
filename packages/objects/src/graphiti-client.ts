import "server-only";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";
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
// Protocol-revision negotiation — EXPLICIT legacy, not defaulted legacy.
//
// The peer on this surface is a PINNED image: zepai/knowledge-graph-mcp
// 1.0.2-graphiti-0.28.2 (digest-pinned in docker-compose.yml). That image was
// PROBED for the 2026-07-28 revision, and the answer is no: it rejects
// `server/discover` outright, and it requires the 2025-era session handshake.
// The measured wire behaviour, against that exact digest:
//
//   { mode: "legacy" } -> era "legacy", negotiated 2025-11-25, 5 HTTP frames
//   { mode: "auto" }   -> era "legacy", negotiated 2025-11-25, 6 HTTP frames
//                         (the extra frame is a `server/discover` answered
//                          400 / -32600 "Missing session ID", then the same
//                          legacy `initialize` fallback)
//
// So `auto` reaches the identical era at the cost of one rejected round trip.
// This client opens a fresh connection PER CALL, so that cost would be paid
// per call, not once per process — which is what makes explicit legacy the
// correct setting here rather than a temporary concession.
//
// The peer's session id is peer-required and stays SDK-managed and
// transport-private: cinatra never reads, persists, routes, or authorizes on
// it (cinatra#2218 AC4).
//
// Two reasons the mode is written out rather than left to the default:
//
//  1. The default IS legacy, so an omitted option and a deliberate legacy
//     choice are indistinguishable in the source. This one is deliberate.
//  2. `versionNegotiation` is an OPTIONS OBJECT. Written as a bare string
//     (`versionNegotiation: "legacy"`) the client reads `options?.mode` as
//     `undefined` and silently falls back to its default — so a bare string
//     produces a working client whose era was never actually chosen. That was
//     confirmed on the wire too: a bare string issued no `server/discover` at
//     all. Typing this constant as `VersionNegotiationOptions` makes the bare
//     string a compile error, and a test asserts the object reaches the
//     `Client` constructor with `mode === "legacy"`.
//
// FOLLOW-UP CONDITION (cinatra#2218): flip to `{ mode: "auto" }` when the
// graphiti pin moves to an image that answers `server/discover` — re-run the
// probe at that bump. That flip is the only change required here; nothing else
// in this module is era-dependent. `graphiti-wire-negotiation.manual.test.ts`
// is the re-runnable probe.
// ---------------------------------------------------------------------------
const GRAPHITI_VERSION_NEGOTIATION: VersionNegotiationOptions = { mode: "legacy" };

// ---------------------------------------------------------------------------
// Low-level MCP call — creates a fresh connection per call. This is slightly
// less efficient than a persistent connection but much more reliable in a
// Next.js server context where module-level state is not guaranteed to persist
// across invocations.
//
// ERROR TAXONOMY across the cinatra#2218 L2a client migration. The error
// classes this module RE-THROWS from the library changed, measured against the
// pinned peer and against synthetic HTTP failures:
//
//   failure mode                 sdk@1.29.0                client@2.0.0
//   ---------------------------  ------------------------  ---------------------
//   peer unreachable             TypeError "fetch failed"  TypeError "fetch failed"
//   peer answers HTTP 4xx/5xx    StreamableHTTPError       SdkHttpError
//                                (name "Error", message    (name "SdkHttpError",
//                                 prefixed "Streamable      same message without
//                                 HTTP error: ")            the prefix)
//   peer answers non-JSON        SyntaxError               SyntaxError
//
// This is stated rather than normalized because NO caller of this module
// discriminates on those classes. Audited, whole-repo:
//
//   - `graphiti-projector.ts` and the `objects_list` recall path in
//     `mcp/handlers.ts` catch broadly and LOG the error object, then degrade;
//   - `graphiti-rebuild.ts` records `err instanceof Error ? err.message :
//     String(err)` into the journal's `last_error`;
//   - `src/lib/register-objects-provider.ts` (the CRM episode adapter) does not
//     catch at all — the error propagates to its own caller, which stringifies;
//   - `getStatus` below maps the error to a `detail` string.
//
// `instanceof Error` and a non-empty `.message` are therefore the whole
// consumer-visible contract, and both hold identically before and after —
// locked by tests. Reconstructing v1's class and message prefix would be dead
// abstraction and would discard v2's richer error identity.
//
// (For contrast: the marketplace client surface DOES discriminate by class, in
// `src/app/configuration/instance/actions.ts`. That is a different lane's
// migration and a different constraint; nothing on this path shares it.)
//
// Errors raised by this module itself — the unexpected-response-format error,
// the `JSON.parse` SyntaxError, and the zod parse errors in the exported
// functions — are unchanged.
// ---------------------------------------------------------------------------
async function callMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const baseUrl = getGraphitiUrl();
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    // Use undici fetch so the connection is not bound to the Next.js request
    // AbortSignal, which would abort SSE streams when the RSC render completes.
    // The cast survives the client@2.0.0 migration and is still required: the
    // option is typed `FetchLike` over the DOM `RequestInit`, while undici
    // declares its own structurally incompatible `RequestInit` (its `body`
    // rejects `ArrayBufferView<ArrayBuffer>`). The mismatch is in the type
    // declarations only — undici's fetch is what we deliberately want here.
    fetch: undiciFetch as unknown as typeof fetch,
    requestInit: { signal: AbortSignal.timeout(30_000) },
  });
  const client = new Client(
    { name: "cinatra-objects", version: "1.0.0" },
    { versionNegotiation: GRAPHITI_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    // `content` has a schema default, so it is always present on a well-formed
    // result; the `?? []` keeps the "unexpected response format" error below as
    // the failure mode for a malformed one, rather than a TypeError on .find().
    const content = result.content ?? [];
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
