import "server-only";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FetchLike, VersionNegotiationOptions } from "@modelcontextprotocol/client";
// undici fetch is used instead of global fetch to bypass Next.js's patched
// fetch, which would propagate the request-lifecycle AbortSignal and abort the
// transport's SSE stream, and which applies its own caching/dedup policy to the
// GET the 2025-era leg opens. Same reason as packages/objects/src/graphiti-client.ts.
import { fetch as undiciFetch } from "undici";

import {
  listEnabledGlobalExternalMcpServers,
  resolveExternalMcpServerBearer,
  type ExternalMcpServerRecord,
} from "@/lib/external-mcp-registry";

// ---------------------------------------------------------------------------
// Internal helper — resolve the bearer for a server row. Routed through the
// registry's `resolveExternalMcpServerBearer` (cinatra#952 W2), which gates
// EVERY external-MCP credential mint through the per-connection use-gate
// (identity row, audited InternalWorker bound to the row's organization) —
// this module no longer touches the raw credential fetch primitives.
// ---------------------------------------------------------------------------

async function resolveAuthHeader(
  row: ExternalMcpServerRecord,
): Promise<{ Authorization: string } | undefined> {
  try {
    const bearer = await resolveExternalMcpServerBearer(row);
    if (bearer) return { Authorization: `Bearer ${bearer}` };
  } catch {
    // Nango/identity store unavailable — proceed without auth header
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Protocol-revision negotiation — EXPLICIT auto (cinatra#2218 L2c).
//
// This surface calls ARBITRARY THIRD-PARTY MCP servers: rows an administrator
// registers in the external-MCP registry, at URLs cinatra does not control and
// does not pin. That is the opposite of the graphiti surface, whose peer is a
// digest-pinned image that was probed once and is known 2025-era — there,
// explicit `{ mode: "legacy" }` is a measured fact about a known peer. Here
// there is no single peer to measure: every row may be a different
// implementation on a different revision, and the set changes at runtime
// whenever an admin adds a row. `{ mode: "auto" }` is therefore the only mode
// that can be correct for this surface — it negotiates PER PEER, preferring
// 2026-07-28 where the peer answers `server/discover` and falling back to the
// 2025-era `initialize` handshake where it does not. It is also the TARGET the
// supported-revisions contract doc records for this row.
//
// Measured on the wire against real peers (see
// `external-mcp-caller-negotiation.test.ts`, which drives the exported function
// below against a real `@modelcontextprotocol/server@2.0.0` peer through a
// frame-recording proxy):
//
//   peer                     mode passed        era     revision     HTTP frames
//   -----------------------  -----------------  ------  -----------  -----------
//   modern (2026-07-28)      { mode: "auto" }   modern  2026-07-28   2
//   2025-era only            { mode: "auto" }   legacy  2025-11-25   4
//   modern (2026-07-28)      "auto" (a STRING)  legacy  2025-11-25   3
//
// The third row is the TRAP, and this surface is where it bites hardest:
// `versionNegotiation` is an OPTIONS OBJECT, so a bare string leaves
// `options?.mode` undefined and the client silently takes its `'legacy'`
// default. Written as a string, a peer that DOES speak 2026-07-28 is served on
// the old era and nothing anywhere reports it. Two guards: the constant is
// typed `VersionNegotiationOptions`, so a bare string is a compile error at
// this call site; and the tests assert both the constructor option
// (`mode === "auto"`, not a string, not "legacy") and the negotiated era
// observed on the wire against both peer classes.
// ---------------------------------------------------------------------------
const EXTERNAL_MCP_VERSION_NEGOTIATION: VersionNegotiationOptions = { mode: "auto" };

// ---------------------------------------------------------------------------
// Per-server wall-clock budget. Unchanged from the pre-migration value: this is
// a best-effort enrichment on the user-facing `agent_compile` path that walks
// every enabled global row SEQUENTIALLY, so the budget is what bounds compile
// latency when a registered server is unreachable or black-holing.
//
// What DID change is what the budget covers. It used to bound a single
// `tools/list` POST and nothing else — in particular NOT the credential step
// that ran before it. It now bounds the whole per-server operation: the
// use-gated credential resolution, the `server/discover` probe, the legacy
// `initialize` fallback where taken, and the `tools/list` itself. Measured
// above: 2 frames against a modern peer, 4 against a 2025-era one.
//
// TRAP, measured — `requestInit: { signal }` DOES NOT BOUND ANYTHING.
//
// The obvious migration of the old `fetch(..., { signal: AbortSignal.timeout(N) })`
// is `new StreamableHTTPClientTransport(url, { requestInit: { signal } })`. It
// is inert. Both the POST and the GET path build their init as
//
//     { ...this._requestInit, method, headers, signal }
//
// so the transport's OWN signal overwrites ours. Measured against a black-hole
// peer that accepts the connection and never answers:
//
//   requestInit.signal = AbortSignal.timeout(1200)   -> returned after 20005ms
//                                                       (the protocol timeout,
//                                                        not ours)
//   custom fetch imposing the same deadline          -> returned after 1203ms
//   connect(transport, { timeout: 1200 })            -> returned after 1202ms
//
// Left on `requestInit` alone, an unresponsive registered server would hold
// `agent_compile` for the SDK's default 60s request timeout instead of 5s. So
// the budget is imposed in the two places that ARE honoured:
//
//   1. a custom `fetch` that merges the deadline into every HTTP request the
//      transport makes (the like-for-like replacement of the old signal), and
//   2. the protocol-level `timeout` on `connect()` and `listTools()`, which
//      also covers "peer accepted the request and then went silent".
//
// This shape is not specific to client@2.0.0 — `sdk@1.29.0`'s transport builds
// its init the same way (`signal: this._abortController?.signal` after
// `...this._requestInit`), so it is a property of the SDK family rather than
// something the migration introduced.
// ---------------------------------------------------------------------------
const EXTERNAL_MCP_TIMEOUT_MS = 5_000;

/**
 * `undiciFetch` with `deadline` merged into every request the transport makes.
 *
 * The transport overwrites `requestInit.signal` (see above), but it does NOT
 * overwrite the `fetch` implementation, so this is the one place a caller can
 * impose a real network budget on the whole connection.
 *
 * The cast is the same one graphiti-client.ts carries and is required for the
 * same reason: undici declares its own structurally incompatible `RequestInit`
 * (its `body` rejects `ArrayBufferView<ArrayBuffer>`). The mismatch is in the
 * type declarations only.
 */
function budgetedFetch(deadline: AbortSignal): FetchLike {
  const baseFetch = undiciFetch as unknown as typeof fetch;
  return (url, init) =>
    baseFetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
}

/**
 * Settle `work`, or give up when `deadline` fires — whichever happens first.
 *
 * Needed because the credential step is NOT an HTTP call this module makes: it
 * goes through the registry's use-gate into the identity store, which takes no
 * abort signal. Without this race the per-server budget would start only after
 * that step returned, so a stalled identity store would hold `agent_compile`
 * open indefinitely — the budget would bound the MCP exchange and nothing else.
 * The abandoned work keeps running to completion in the background; that is
 * safe here because `resolveAuthHeader` catches internally and never rejects.
 */
function withinDeadline<T>(work: Promise<T>, deadline: AbortSignal, what: string): Promise<T> {
  const expired = () =>
    new Error(`${what} exceeded the ${EXTERNAL_MCP_TIMEOUT_MS}ms per-server budget`);
  if (deadline.aborted) return Promise.reject(expired());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(expired());
    deadline.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => deadline.removeEventListener("abort", onAbort));
  });
}

/**
 * Tool names exported by ONE registered server, over a negotiated MCP
 * connection. Throws on any failure — the caller below treats a per-server
 * failure as "skip this server", never as a failure of the whole walk.
 */
async function listToolNamesFromServer(row: ExternalMcpServerRecord): Promise<string[]> {
  // The deadline is armed FIRST so the budget covers the whole per-server
  // operation — credential resolution included — rather than only the part of
  // it that happens to be HTTP requests this module issues.
  const deadline = AbortSignal.timeout(EXTERNAL_MCP_TIMEOUT_MS);
  const authHeader = await withinDeadline(
    resolveAuthHeader(row),
    deadline,
    "external MCP credential resolution",
  );

  const transport = new StreamableHTTPClientTransport(new URL(row.serverUrl), {
    fetch: budgetedFetch(deadline),
    // Headers only. The bearer is resolved ONCE per server, above, and carried
    // as a static header — deliberately NOT through the SDK's `authProvider`,
    // whose `token()` is invoked before EVERY HTTP request and would multiply
    // the audited, use-gated credential mints per row (2 mints on a modern
    // peer, 4 on a legacy one, instead of 1). Content-Type and Accept are the
    // SDK's to set; the pre-migration code's hand-set `Accept: application/json`
    // is exactly what a spec-conformant peer answers `406`.
    ...(authHeader ? { requestInit: { headers: authHeader } } : {}),
  });

  const client = new Client(
    { name: "cinatra-agents", version: "1.0.0" },
    { versionNegotiation: EXTERNAL_MCP_VERSION_NEGOTIATION },
  );

  try {
    await client.connect(transport, { timeout: EXTERNAL_MCP_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, { timeout: EXTERNAL_MCP_TIMEOUT_MS });
    // `tool.name` is schema-required, but the pre-migration code filtered
    // falsy names and the dedup below depends on that; keep it.
    return tools.map((tool) => tool.name).filter((name) => Boolean(name));
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// fetchExternalMcpToolNames
//
// Fetches tool names from all enabled global external MCP servers.
// Per-server failures are caught and logged — never thrown.
// Returns deduplicated string[]; empty array when none are registered or all fail.
//
// CONSUMER CONTRACT, unchanged by the cinatra#2218 L2c migration. The sole
// consumer is `handleAgentBuilderCompile` in `src/mcp/handlers.ts`, which
// dynamic-imports this function and concatenates its result with the platform
// primitive names before handing the list to `compileWorkflow`. It depends on
// exactly three things, all preserved and locked by tests:
//
//   1. a `string[]`, deduplicated, in first-seen order;
//   2. NEVER throws — a per-server failure is logged and skipped, and an
//      all-servers-failed walk returns `[]`;
//   3. `[]` when no rows are registered.
//
// Because every error is caught HERE, the v1 -> v2 error-class change is not
// observable to any consumer: nothing escapes this module. What changed is the
// text that reaches the log line — hand-built strings like
// `HTTP 404 Not Found` / `Response missing result.tools array` are replaced by
// the SDK's own `SdkError` / `SdkHttpError` / `TypeError` messages. The log
// line's prefix and shape are unchanged, and nothing parses it.
//
// PEER-CLASS REGRESSION, stated rather than argued away. The migration is a
// strict improvement for every CONFORMANT peer — a 2025-era peer that requires
// the handshake, and a 2026-07-28 peer, both become reachable where the
// hand-rolled POST failed. It is NOT a strict improvement for every peer that
// happened to work. Two classes measured on the wire become unreachable, and
// both are non-conformant with the MCP spec in either era:
//
//   1. a peer that answers a bare `tools/list` with no handshake AND accepts
//      `Accept: application/json` alone, but does not implement `initialize`.
//      (Both extra conditions matter: a conformant 2025-era peer answers that
//      Accept header `406` before any protocol question, so this class is
//      narrower than "permissive 2025-era server".)
//   2. a peer whose `tools/list` result is not schema-conformant — measured
//      case: `{ tools: [{ name: "x" }] }` with no `inputSchema`. The old code
//      read `.name` off whatever JSON came back; `client.listTools()` validates
//      the result and rejects, so the WHOLE row yields nothing rather than the
//      names it used to.
//
// Neither class is silently swallowed: each fails per-row, is logged with the
// row label below, and leaves the compile running with the remaining rows —
// the same degradation as an unreachable server. Recovering them would mean
// keeping a hand-rolled parse beside the SDK client, which is the exact
// unstatable-revision-posture problem this lane exists to remove.
//
// The other export this module used to carry, `callExternalMcpTool`, was
// DELETED in the same change rather than migrated: it had no call site
// anywhere in the repo, was not re-exported from the package barrel, and is not
// reachable through `@cinatra-ai/agents`' `exports` map. See the PR for the
// full deletion evidence.
// ---------------------------------------------------------------------------

export async function fetchExternalMcpToolNames(): Promise<string[]> {
  let servers: ExternalMcpServerRecord[];
  try {
    servers = listEnabledGlobalExternalMcpServers();
  } catch (err) {
    // Enumerating the rows is a synchronous Postgres read and CAN throw
    // (unreachable database, missing schema). Before this guard the throw
    // escaped to `handleAgentBuilderCompile`, whose catch turns any throw into
    // `Compile failed: …` — so an unrelated registry outage failed the compile
    // outright, contradicting the "never block compilation" intent recorded at
    // that call site. Degrade the same way a failing server does.
    console.log(
      `[external-mcp-caller] skipping all external servers: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const allNames: string[] = [];

  for (const row of servers) {
    try {
      allNames.push(...(await listToolNamesFromServer(row)));
    } catch (err) {
      console.log(
        `[external-mcp-caller] skipping ${row.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Deduplicate
  return [...new Set(allNames)];
}
