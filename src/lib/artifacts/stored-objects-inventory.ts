import "server-only";
/**
 * Stored objects inventory — the data source for the Artifacts console's Stored
 * objects tab (cinatra#1786, spec design@923fa0d8 §IV).
 *
 * The Stored objects tab is the GLOBAL inventory: every stored object of every
 * artifact extension, one workspace-wide list for record inspection, never
 * scoped to a single extension. Each row names the object by its display name
 * over a mono meta line (type id · object id · version · updated), and the
 * row's right edge carries the object's scope as an ENTITY-NAMED label —
 * "Team: Growth", "Organization: Acme Corp". Read-only — record inspection
 * only, no mutation.
 *
 * Artifacts are stored as objects of the single semantic artifact object type;
 * the real per-object type id lives in `data.artifactType`, the display name in
 * `data.title`. This loader reads the artifact objects org-wide (the console is
 * admin-gated), batch-resolves each team/organization owner id to its entity
 * name, and projects the rows. The projection (`projectStoredObjectRows`) is a
 * PURE reshape taking an injected name resolver, so it is unit-testable without
 * a DB; the server loader wires the real object-store read + name lookup.
 */
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ObjectRecord } from "@/lib/objects-store";

// ---------------------------------------------------------------------------
// Row model + pure projection
// ---------------------------------------------------------------------------

export type StoredObjectRow = {
  objectId: string;
  /** The real artifact type id (from `data.artifactType`). */
  typeId: string;
  /** Display name — `data.title`, falling back to the object id. */
  displayName: string;
  version: number;
  updatedAt: string;
  /** Entity-named scope label: "Team: Growth", "Organization: Acme Corp",
   *  "Workspace", or "Private" (user-owned). */
  scopeLabel: string;
};

type OwnerLevel = "user" | "team" | "organization" | "workspace";

/** Resolves a (level, ownerId) pair to a display entity name, or null when the
 *  name is unknown (a deleted / unreadable owner) — the projection then falls
 *  back to the bare level label. */
export type ScopeNameResolver = (
  level: "team" | "organization",
  ownerId: string,
) => string | null;

function normalizeOwnerLevelValue(level: string | null | undefined): OwnerLevel {
  if (level === "user" || level === "team" || level === "organization" || level === "workspace") {
    return level;
  }
  return "organization";
}

function scopeLabelFor(
  level: OwnerLevel,
  ownerId: string | null,
  resolveName: ScopeNameResolver,
): string {
  switch (level) {
    case "team": {
      const name = ownerId ? resolveName("team", ownerId) : null;
      return name ? `Team: ${name}` : "Team";
    }
    case "organization": {
      const name = ownerId ? resolveName("organization", ownerId) : null;
      return name ? `Organization: ${name}` : "Organization";
    }
    case "workspace":
      return "Workspace";
    case "user":
      return "Private";
  }
}

type StoredObjectData = { artifactType?: string; title?: string };

/**
 * PURE reshape: project artifact object records into Stored objects rows,
 * resolving each row's entity-named scope through the injected resolver. Rows
 * are ordered by most-recently-updated first (the inventory's default recency
 * ordering), then by object id to break ties deterministically.
 */
export function projectStoredObjectRows(
  records: ReadonlyArray<
    Pick<ObjectRecord, "id" | "data" | "version" | "updatedAt" | "ownerLevel" | "ownerId">
  >,
  resolveName: ScopeNameResolver,
): StoredObjectRow[] {
  const rows = records.map((rec) => {
    const d = (rec.data ?? {}) as StoredObjectData;
    const level = normalizeOwnerLevelValue(rec.ownerLevel);
    return {
      objectId: rec.id,
      typeId: d.artifactType ?? "file",
      displayName: d.title && d.title.trim() ? d.title.trim() : rec.id,
      version: rec.version,
      updatedAt: rec.updatedAt ?? "",
      scopeLabel: scopeLabelFor(level, rec.ownerId ?? null, resolveName),
    } satisfies StoredObjectRow;
  });
  rows.sort(
    (a, b) =>
      (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
      a.objectId.localeCompare(b.objectId),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Server loader — wires the real object read + name resolution
// ---------------------------------------------------------------------------

const INVENTORY_LIMIT = 200;

/**
 * Batch-resolve team + organization owner ids to their entity names via the
 * Better Auth org/team tables. Returns a synchronous resolver over the
 * pre-fetched name maps so the pure projection stays free of async/IO.
 */
async function buildScopeNameResolver(
  records: ReadonlyArray<Pick<ObjectRecord, "ownerLevel" | "ownerId">>,
): Promise<ScopeNameResolver> {
  const teamIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const rec of records) {
    if (!rec.ownerId) continue;
    if (rec.ownerLevel === "team") teamIds.add(rec.ownerId);
    else if (rec.ownerLevel === "organization") orgIds.add(rec.ownerId);
  }

  const teamNames = new Map<string, string>();
  const orgNames = new Map<string, string>();
  if (teamIds.size > 0 || orgIds.size > 0) {
    const { inArray } = await import("drizzle-orm");
    const { betterAuthDb, betterAuthOrganizations, betterAuthTeams } = await import(
      "@/lib/better-auth-db"
    );
    await Promise.all([
      orgIds.size > 0
        ? betterAuthDb
            .select({ id: betterAuthOrganizations.id, name: betterAuthOrganizations.name })
            .from(betterAuthOrganizations)
            .where(inArray(betterAuthOrganizations.id, Array.from(orgIds)))
            .then((rows) => {
              for (const r of rows) if (r.name) orgNames.set(r.id, r.name);
            })
        : Promise.resolve(),
      teamIds.size > 0
        ? betterAuthDb
            .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
            .from(betterAuthTeams)
            .where(inArray(betterAuthTeams.id, Array.from(teamIds)))
            .then((rows) => {
              for (const r of rows) if (r.name) teamNames.set(r.id, r.name);
            })
        : Promise.resolve(),
    ]);
  }

  return (level, ownerId) =>
    (level === "team" ? teamNames : orgNames).get(ownerId) ?? null;
}

/**
 * Load the Stored objects inventory rows for the acting org. Reads every
 * artifact object (the single semantic artifact object type), resolves each
 * team/org scope's entity name, and projects the rows most-recent-first.
 *
 * `orgId === null` (no active org) yields an empty inventory. Any store error
 * propagates to the caller, which renders the error state.
 */
export async function loadStoredArtifactObjects(input: {
  orgId: string | null;
  actor?: ActorContext;
}): Promise<StoredObjectRow[]> {
  if (input.orgId === null) return [];
  const { listObjectsByFilter } = await import("@/lib/objects-store");
  // Fan out over the type-driven artifact set (epic #1785 wave A4): the generic
  // base (legacy rows, until the A6 purge) PLUS every registered isArtifact PACK
  // type — the A3 writer stamps a row's EXACT declared pack type into
  // objects.type, so a generic-only query would silently omit every pack-typed
  // row from the inventory. Warm the registry first (idempotent) so the set is
  // complete in a fresh process.
  const { ensureArtifactTypesRegistered } = await import("./ensure-artifact-registry");
  ensureArtifactTypesRegistered();
  const typeIds = new Set<string>([SEMANTIC_ARTIFACT_OBJECT_TYPE]);
  for (const def of objectTypeRegistry.listArtifacts()) typeIds.add(def.type);
  const records: ObjectRecord[] = [];
  for (const type of typeIds) {
    records.push(
      ...listObjectsByFilter(
        { orgId: input.orgId, type, limit: INVENTORY_LIMIT },
        input.actor,
      ),
    );
  }
  const resolveName = await buildScopeNameResolver(records);
  // `projectStoredObjectRows` sorts most-recently-UPDATED first; cap the merged,
  // sorted set to the inventory limit so the fan-out never exceeds the
  // single-query render budget. NOTE: each per-type fetch is itself capped at
  // INVENTORY_LIMIT by the store's created_at-DESC order, so — as with the
  // pre-A4 generic-only query — a type with more than INVENTORY_LIMIT rows can
  // omit a recently-UPDATED-but-old-created row. Acceptable for this admin
  // record-inspection surface; the fan-out is a strict superset of the prior
  // (generic-only) result.
  return projectStoredObjectRows(records, resolveName).slice(0, INVENTORY_LIMIT);
}
