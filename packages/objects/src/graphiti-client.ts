import "server-only";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { createHash, randomUUID } from "crypto";
// The usage-event bus leaf (NOT @cinatra-ai/metric-usage-api, whose entry also
// re-exports an MCP module). cinatra#2582: this module is a registered usage
// publisher — see src/__tests__/llm-usage-ledger-chokepoint.test.ts.
import { emitUsageEvent } from "@cinatra-ai/metric-contracts";
// undici fetch is used instead of global fetch to bypass Next.js's patched fetch,
// which would propagate the request-lifecycle AbortSignal and abort long-lived SSE connections.
import { fetch as undiciFetch } from "undici";
import type {
  AddEpisodeInput,
  SearchNodesInput,
  GetEpisodesInput,
  DeleteEpisodeInput,
  ClearGraphInput,
  AddTripletInput,
  GetEpisodeEntitiesInput,
  AddEpisodeResult,
  SearchNodesResult,
  GetEpisodesResult,
  AddTripletResult,
  GetEpisodeEntitiesResult,
  EpisodeNode,
  EntityNode,
  EntityEdge,
} from "./graphiti-types";
import {
  addEpisodeResultSchema,
  searchNodesResultSchema,
  getEpisodesResultSchema,
  addTripletResultSchema,
  getEpisodeEntitiesResultSchema,
  graphitiStatusSchema,
} from "./graphiti-types";

const DEFAULT_GRAPHITI_URL = "http://graphiti:8000";

function getGraphitiUrl(): string {
  return process.env.GRAPHITI_URL ?? DEFAULT_GRAPHITI_URL;
}

// ---------------------------------------------------------------------------
// Protocol-revision negotiation — EXPLICIT legacy, not defaulted legacy.
//
// RE-PROBED 2026-08-10 AGAINST THE REPLACEMENT SERVER (cinatra#2591). The peer
// is no longer zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2 — it is upstream
// getzep/graphiti's own MCP server, built by docker/graphiti/Dockerfile
// (upstream 425bf248, graphiti-core 0.29.3, python-mcp 1.29.0). cinatra#2218
// left a standing FOLLOW-UP CONDITION: flip to `{ mode: "auto" }` when the pin
// moves to an image that answers `server/discover`. The pin has now moved, so
// the probe was re-run, and the condition is STILL NOT MET:
//
//   POST /mcp {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}
//     -> HTTP 400
//        {"error":{"code":-32600,"message":"Bad Request: Missing session ID"}}
//
//   POST /mcp {"...","method":"initialize","params":{"protocolVersion":"2025-11-25",…}}
//     -> HTTP 200, negotiated protocolVersion 2025-11-25, with the peer
//        identifying itself as the upstream graphiti server on python-mcp 1.29.0
//
// The rejection is identical to the old wrapper's because it has the same
// cause: the server's Streamable-HTTP layer demands an established session
// before it will route ANY method, and a session only exists after the legacy
// `initialize`. Upgrading graphiti did not change that — it is a property of
// the python MCP SDK's transport, not of the graphiti application.
//
// So the measured trade-off is unchanged:
//
//   { mode: "legacy" } -> era "legacy", negotiated 2025-11-25, 5 HTTP frames
//   { mode: "auto" }   -> era "legacy", negotiated 2025-11-25, 6 HTTP frames
//                         (the extra frame is the `server/discover` above,
//                          rejected, then the same legacy `initialize`)
//
// `auto` reaches the identical era at the cost of one rejected round trip.
// This client opens a fresh connection PER CALL, so that cost would be paid
// per call, not once per process — which is what makes explicit legacy the
// correct setting here rather than a temporary concession. cinatra#2591 AC3 is
// therefore answered on its "or its retention justified against the new server"
// branch: RETAINED, with a fresh measurement rather than an inherited one.
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
// FOLLOW-UP CONDITION (cinatra#2218, re-armed by cinatra#2591): flip to
// `{ mode: "auto" }` when the peer answers `server/discover` — re-run the probe
// at every bump of GRAPHITI_UPSTREAM_REF in docker/graphiti/Dockerfile. That
// flip is the only change required here; nothing else in this module is
// era-dependent. `graphiti-wire-negotiation.manual.test.ts` is the re-runnable
// probe, and `scripts/ci/works-after/graphiti.sh` re-asserts the answer on
// every works-after run so the justification cannot go stale silently.
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
// Knowledge-graph provider-key state (cinatra#2582).
//
// Whether the indexer can index at all depends on a fact this package cannot
// read: does the app's stored provider configuration hold an OpenAI key (the key
// the bring-up materializes into the container)? Extraction runs BEFORE the
// Neo4j write, so with no key an episode is accepted and then never stored —
// the silent-empty-graph behaviour the issue reports.
//
// The host binds a probe at boot (`src/lib/register-objects-provider.ts`). Three
// answers, and what each does here:
//
//   absent      → say so ONCE per process on the projection path (a keyless
//                 install should be able to see why its graph is empty) and emit
//                 NO usage row: there is no provider fan-out to bill.
//   configured  → emit.
//   unknown     → emit. "Unknown" means the question could not be answered (no
//                 probe bound, an unreadable configuration), and the defect this
//                 metering exists to fix is spend that is INVISIBLE — an
//                 unattributed row beats a dropped one.
//
// NOTE the vocabulary: `configured` is what the APP holds, not proof of what
// the running container was started with (the pinned wrapper reports no
// readiness). A key saved after the container started is configured and not yet
// in use, which is why nothing here claims "indexing is on".
// ---------------------------------------------------------------------------

export type KnowledgeGraphProviderKeyState = {
  providerKey: "configured" | "absent" | "unknown";
  /** Operator-facing explanation. NEVER carries a key or any part of one. */
  reason: string;
};

const UNKNOWN_PROVIDER_KEY_STATE: KnowledgeGraphProviderKeyState = {
  providerKey: "unknown",
  reason: "no knowledge-graph indexing probe is bound in this process",
};

let indexingProbe: (() => KnowledgeGraphProviderKeyState) | null = null;
let warnedIndexingOff = false;

/**
 * Bind the host's indexing-state probe. Idempotent; the host calls it at boot.
 * The probe must be cheap (the host caches its own read) and must never return
 * the key itself.
 */
export function setKnowledgeGraphIndexingProbe(
  probe: (() => KnowledgeGraphProviderKeyState) | null,
): void {
  indexingProbe = probe;
}

/** Resolve the current state. A throwing probe degrades to `unknown`. */
export function readKnowledgeGraphProviderKeyState(): KnowledgeGraphProviderKeyState {
  if (!indexingProbe) return UNKNOWN_PROVIDER_KEY_STATE;
  try {
    return indexingProbe();
  } catch (err) {
    return {
      providerKey: "unknown",
      reason: `provider-key probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Test seam: the once-per-process warning latch. */
export function __resetKnowledgeGraphIndexingWarningForTests(): void {
  warnedIndexingOff = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function addEpisode(input: AddEpisodeInput): Promise<AddEpisodeResult> {
  // Tool is named "add_memory" in knowledge-graph-mcp 1.0.x (not "add_episode")
  const raw = await callMcp("add_memory", input as Record<string, unknown>);
  // Metered on the CALL succeeding, not on the acknowledgement parsing. The
  // hand-over is what causes the provider fan-out; an acknowledgement whose
  // SHAPE we fail to recognize is still an episode Graphiti accepted and billed,
  // and dropping its row would put the spend back where this change found it.
  recordEpisodeUsage();
  return addEpisodeResultSchema.parse(raw);
}

/**
 * Put ONE `usage_events` row on the bus per episode actually handed over
 * (cinatra#2582 / the Graphiti line item of cinatra#2578).
 *
 * Emitted after the call returns, so a failed hand-over never books spend.
 * The row is counted and UNPRICED — see `GraphitiUsageEvent` for why inventing
 * a token count would be worse than admitting we do not have one.
 *
 * Never throws: metering must not break the projection path (the bus emitter
 * swallows too, this is the second belt).
 */
function recordEpisodeUsage(): void {
  try {
    const state = readKnowledgeGraphProviderKeyState();
    if (state.providerKey === "absent") {
      if (!warnedIndexingOff) {
        warnedIndexingOff = true;
        console.warn(
          "[graphiti] knowledge-graph indexing is OFF — no provider key in the app's stored " +
            `configuration (${state.reason}). Episodes are accepted by the indexer and then ` +
            "dropped: extraction runs before the graph write, so the graph stays empty. " +
            "Configure an OpenAI provider key, then re-run the bring-up so the indexer " +
            "container picks it up.",
        );
      }
      return;
    }
    emitUsageEvent({
      source: "graphiti",
      provider: "openai",
      operation: "episode",
      model: null,
      idempotencyKey: `graphiti:episode:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[graphiti] usage metering failed (episode still sent):", err);
  }
}

/**
 * Seed ONE deterministic entity node for a projected row (cinatra#2591).
 *
 * This is the mechanism that ends the `no_ids_extracted` class of failure. Row
 * recovery used to depend on the extraction model INCIDENTALLY emitting the row
 * UUID as an entity-node name (three of the four recovery probes in
 * `mcp/handlers.ts` were already measured inert). Here the caller chooses the
 * node's UUID, so the node identity is a function of the row, not of what a
 * model happened to say.
 *
 * Returns the RESOLVED nodes. Read the UUID back rather than assuming the one
 * you sent survived: it does in the normal case (measured on the wire
 * 2026-08-10), but graphiti-core resolves a brand-new node against existing
 * near-duplicates, and when it merges, the resolved UUID is the truth.
 *
 * Deliberately NOT metered as a usage event: the write needs the embedder, not
 * the LLM, and on the local embedder floor there is no provider fan-out to
 * bill. The episode hand-over next to it is the metered seam.
 */
export async function addTriplet(input: AddTripletInput): Promise<AddTripletResult> {
  const raw = await callMcp("add_triplet", input as Record<string, unknown>);
  return addTripletResultSchema.parse(raw);
}

/**
 * Forward provenance: which nodes/edges did these episodes produce?
 *
 * New in the upstream server (absent from the 1.0.x wrapper). Not on the recall
 * hot path — recall resolves through the deterministic anchor above — but it is
 * how an extracted entity is attributed back to the episode, and therefore the
 * row, that produced it.
 */
export async function getEpisodeEntities(
  input: GetEpisodeEntitiesInput,
): Promise<GetEpisodeEntitiesResult> {
  const raw = await callMcp("get_episode_entities", input as Record<string, unknown>);
  return getEpisodeEntitiesResultSchema.parse(raw);
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
export type { EpisodeNode, EntityNode, EntityEdge };
