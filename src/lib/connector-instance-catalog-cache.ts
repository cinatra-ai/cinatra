import "server-only";

// Governed connector-instance catalog cache (cinatra#2017 S2 slice K5, design
// §1.4 / §3.3 / §3.5 / §3.6). S2 delivers the INTERFACE + default-server
// population + presence check + per-server exposure-mode record + revision
// semantics; S3 owns per-server TTL / max-stale / invalidation / multi-server
// lifecycle (N6). The cache read happens ONLY AFTER the invoker's step-0/step-1
// gates (B2) — never before authorization.
//
// KEY: per-`(instanceId, serverId)` where `serverId` is the STABLE, OPAQUE,
// host-owned identity (§10-A1) — NOT endpoint-, URL-, or normalized-name-derived.
// S2's always-enrolled default server is the constant `CATALOG_DEFAULT_SERVER_ID`.
//
// The cache records, per server: the EXPOSURE MODE (`triad-only | first-class`),
// the EXPANDED catalog (ability rows from discover+get-info on triad servers;
// native `tools[]` on first-class servers), each tool's `rawAnnotations` +
// schema-bearing fields (A2), and a `catalogRevision` (§3.5 revision-pinned
// cursor snapshot). The pure resolution/composition helpers below are the
// testable core (duplicate-name routing is built + unit-tested against a
// synthetic 2nd server so S3's multi-server generalization is a DATA change).

import {
  TRIAD_DISCOVER_ABILITIES,
  TRIAD_GET_ABILITY_INFO,
} from "@/lib/connector-instance-mcp-transport";

/** The STABLE, OPAQUE host-owned server id for the always-enrolled default
 * mcp-adapter server (§10-A1). Never endpoint-derived; S3 assigns
 * host-generated ids to further enrolled servers and collision-checks this. */
export const CATALOG_DEFAULT_SERVER_ID = "mcp-adapter-default";

export type CatalogExposureMode = "triad-only" | "first-class";

/** One expanded catalog tool. `inputSchema` is REQUIRED (A2 — the advertised
 * arg schema, forwarded verbatim to callers, §3.7); `rawAnnotations` is present
 * on every row (unannotated → `{}`, report-never-drop, §3.5). */
export type CatalogToolEntry = {
  name: string;
  serverId: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  label?: string;
  description?: string;
  rawAnnotations: Record<string, unknown>;
};

/** A per-`(instance, server)` catalog snapshot. `catalogRevision` is monotonic
 * per snapshot; a cursor minted against it pages consistently, and a re-fetch
 * (new snapshot) bumps it so a stale cursor is rejected (§3.5). */
export type CatalogServerSnapshot = {
  serverId: string;
  exposureMode: CatalogExposureMode;
  tools: CatalogToolEntry[];
  catalogRevision: string;
  fetchedAtMs: number;
};

/** The cache interface. S2 ships an in-memory implementation with a conservative,
 * S3-replaceable freshness policy; S3 owns TTL / max-stale / invalidation. */
export interface ConnectorInstanceCatalogCache {
  get(instanceId: string, serverId: string): CatalogServerSnapshot | undefined;
  set(instanceId: string, snapshot: CatalogServerSnapshot): void;
  listForInstance(instanceId: string): CatalogServerSnapshot[];
  invalidate(instanceId: string, serverId?: string): void;
}

function cacheKey(instanceId: string, serverId: string): string {
  return `${instanceId}::${serverId}`;
}

/** In-memory catalog cache (S2 default). Keyed per-(instance, server) on the
 * opaque serverId. S3 replaces the freshness policy / lifecycle. */
export function createInMemoryConnectorInstanceCatalogCache(): ConnectorInstanceCatalogCache {
  const store = new Map<string, CatalogServerSnapshot>();
  const byInstance = new Map<string, Set<string>>();
  return {
    get(instanceId, serverId) {
      return store.get(cacheKey(instanceId, serverId));
    },
    set(instanceId, snapshot) {
      store.set(cacheKey(instanceId, snapshot.serverId), snapshot);
      let set = byInstance.get(instanceId);
      if (!set) {
        set = new Set();
        byInstance.set(instanceId, set);
      }
      set.add(snapshot.serverId);
    },
    listForInstance(instanceId) {
      const ids = byInstance.get(instanceId);
      if (!ids) return [];
      const out: CatalogServerSnapshot[] = [];
      for (const serverId of ids) {
        const snap = store.get(cacheKey(instanceId, serverId));
        if (snap) out.push(snap);
      }
      return out;
    },
    invalidate(instanceId, serverId) {
      if (serverId) {
        store.delete(cacheKey(instanceId, serverId));
        byInstance.get(instanceId)?.delete(serverId);
        return;
      }
      const ids = byInstance.get(instanceId);
      if (ids) {
        for (const id of ids) store.delete(cacheKey(instanceId, id));
        byInstance.delete(instanceId);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Revision generation — monotonic per snapshot (§3.5). Kept simple + injectable
// for deterministic tests; S3's invalidation is what BUMPS the revision (§3.3).
// ---------------------------------------------------------------------------
let revisionCounter = 0;
export function nextCatalogRevision(): string {
  revisionCounter += 1;
  return `rev-${Date.now()}-${revisionCounter}`;
}

// ---------------------------------------------------------------------------
// Catalog EXPANSION — build a snapshot from the wire (§3.2). Injectable
// `callWireTool` so tests exercise the discover→get-info→row shape with a mock.
// ---------------------------------------------------------------------------

type WireCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeAnnotations(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Expand a TRIAD-ONLY server's catalog: `discover-abilities` enumerates the
 * ability names; `get-ability-info` hydrates each row's schema + annotations
 * (`meta.annotations` — the INNER ability's, never the wire triad tool's, §3.4).
 * Returns a snapshot with `exposureMode:"triad-only"`.
 */
export async function expandTriadCatalog(input: {
  callWireTool: WireCaller;
  serverId: string;
  revision?: string;
  now?: number;
}): Promise<CatalogServerSnapshot> {
  const discovered = asRecord(await input.callWireTool(TRIAD_DISCOVER_ABILITIES, {}));
  const abilities = Array.isArray(discovered.abilities) ? discovered.abilities : [];
  const tools: CatalogToolEntry[] = [];
  for (const raw of abilities) {
    const a = asRecord(raw);
    const name = typeof a.name === "string" ? a.name : undefined;
    if (!name) continue;
    const info = asRecord(await input.callWireTool(TRIAD_GET_ABILITY_INFO, { ability_name: name }));
    const meta = asRecord(info.meta);
    tools.push({
      name,
      serverId: input.serverId,
      inputSchema: info.input_schema ?? {},
      ...(info.output_schema !== undefined ? { outputSchema: info.output_schema } : {}),
      ...(typeof info.label === "string" ? { label: info.label } : typeof a.label === "string" ? { label: a.label } : {}),
      ...(typeof info.description === "string"
        ? { description: info.description }
        : typeof a.description === "string"
          ? { description: a.description }
          : {}),
      rawAnnotations: normalizeAnnotations(meta.annotations),
    });
  }
  return {
    serverId: input.serverId,
    exposureMode: "triad-only",
    tools,
    catalogRevision: input.revision ?? nextCatalogRevision(),
    fetchedAtMs: input.now ?? Date.now(),
  };
}

/**
 * Build a FIRST-CLASS server snapshot from a native `tools[]` list (each ability
 * is its own tool; annotations transported directly, §3.1). Pure — the caller
 * supplies the already-fetched `tools/list` rows.
 */
export function buildFirstClassSnapshot(input: {
  serverId: string;
  tools: Array<Record<string, unknown>>;
  revision?: string;
  now?: number;
}): CatalogServerSnapshot {
  const tools: CatalogToolEntry[] = [];
  for (const raw of input.tools) {
    const t = asRecord(raw);
    const name = typeof t.name === "string" ? t.name : undefined;
    if (!name) continue;
    tools.push({
      name,
      serverId: input.serverId,
      inputSchema: t.inputSchema ?? {},
      ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
      ...(typeof t.title === "string" ? { label: t.title } : typeof t.label === "string" ? { label: t.label } : {}),
      ...(typeof t.description === "string" ? { description: t.description } : {}),
      rawAnnotations: normalizeAnnotations(t.annotations),
    });
  }
  return {
    serverId: input.serverId,
    exposureMode: "first-class",
    tools,
    catalogRevision: input.revision ?? nextCatalogRevision(),
    fetchedAtMs: input.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Presence check + duplicate-name routing (§3.5 / §3.6) — pure over snapshots.
// ---------------------------------------------------------------------------

export type ToolResolution =
  | { ok: true; serverId: string; name: string; entry: CatalogToolEntry; snapshot: CatalogServerSnapshot }
  | { ok: false; reason: "tool_not_found" }
  | { ok: false; reason: "ambiguous_tool"; candidateServerIds: string[] };

/**
 * Resolve `toolName` (optionally narrowed by `serverId`) across an instance's
 * enrolled server snapshots (§3.6). `serverId` is REQUIRED only when the name is
 * non-unique across servers; ambiguous → `ambiguous_tool` with the candidate
 * STABLE OPAQUE server ids (§10-A1, never normalized names); unique → resolved
 * deterministically. Uniqueness runs over the EXPANDED namespace (abilities on
 * triad servers + native tools on first-class servers). Absent → `tool_not_found`
 * (distinct from an absent-stack transport error, §1.4).
 */
export function resolveToolAcrossServers(
  snapshots: readonly CatalogServerSnapshot[],
  toolName: string,
  serverId?: string,
): ToolResolution {
  const matches: Array<{ snapshot: CatalogServerSnapshot; entry: CatalogToolEntry }> = [];
  for (const snapshot of snapshots) {
    if (serverId && snapshot.serverId !== serverId) continue;
    const entry = snapshot.tools.find((t) => t.name === toolName);
    if (entry) matches.push({ snapshot, entry });
  }
  if (matches.length === 0) return { ok: false, reason: "tool_not_found" };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_tool",
      candidateServerIds: matches.map((m) => m.snapshot.serverId),
    };
  }
  const only = matches[0]!;
  return {
    ok: true,
    serverId: only.snapshot.serverId,
    name: only.entry.name,
    entry: only.entry,
    snapshot: only.snapshot,
  };
}

/**
 * Compose the flat, deterministically-sorted row set across an instance's server
 * snapshots for the governed `tools_list` (§3.5). Stable sort key `(serverId,
 * name)` on the STABLE OPAQUE serverId (§10-A1); slash-bearing ability names sort
 * as plain strings. Returns the entries in stable order (the caller applies
 * policy status + classifier + cursor paging).
 */
export function composeSortedCatalog(
  snapshots: readonly CatalogServerSnapshot[],
): CatalogToolEntry[] {
  const all: CatalogToolEntry[] = [];
  for (const snapshot of snapshots) all.push(...snapshot.tools);
  return all.sort((a, b) =>
    a.serverId === b.serverId ? a.name.localeCompare(b.name) : a.serverId.localeCompare(b.serverId),
  );
}
