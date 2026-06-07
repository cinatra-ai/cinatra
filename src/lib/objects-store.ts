import "server-only";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

import { createHash, randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, ensurePostgresSchema, postgresSchema } from "@/lib/database";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
import { getActorContext } from "@cinatra-ai/llm/actor-context";
// Sealed-room reads resolve ambient vs project-scoped mode and consult the
// per-table feature flag. The SQL `AND project_id = $P` clause lives here
// inside listObjectsByFilter so it intersects with every filter shape,
// including Graphiti / semantic search `id IN (...)` candidate sets. A future
// caller that hands in candidate IDs from P + Q + ambient will still see only
// P rows because the project clause is non-bypassable from the data layer.
import { sealedRoomFilterValue } from "@/lib/sealed-room";
// Sync archive gate consumed by the canonical inheritance write paths. Static
// import keeps the vitest @/-alias resolver on the normal module path.
import { assertProjectWritableSync } from "@/lib/project-writable";
// Write-time project inheritance. The worker entry establishes a
// `projectContext` frame via mcpRequestContextStorage; the canonical objects
// writers read it here and, subject to substrate exclusion, propagate the
// projectId to the new objects row at INSERT time.
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { resolveProjectInheritanceForType } from "@/lib/project-inheritance";

/**
 * Fail-closed guard for write paths.
 *
 * `orgId === null` means "system-level — match any row". A non-admin actor
 * whose call slips through with `orgId === null` could overwrite or
 * soft-delete any object in any org. This helper checks the active ALS frame:
 * if an actor is present, `orgId === null` is permitted only for
 * `platformRole === "platform_admin"`. Throws FORBIDDEN otherwise.
 *
 * When no ALS frame is active (legacy non-LLM call paths — server-only
 * worker code, internal cron, etc.) the guard is a no-op for backward
 * compatibility; LLM-reachable paths are gated upstream.
 */
function assertWriteScopeAllowed(
  op: "softDeleteObject" | "upsertObjectAndEnqueue",
  scopeOrgId: string | null,
): void {
  const actor = getActorContext();
  if (!actor) return;
  if (actor.platformRole === "platform_admin") return;
  if (scopeOrgId === null) {
    const err = new Error(
      `${op}: orgId scope required for non-admin actor (cross-tenant guard)`,
    );
    (err as Error & { code: string }).code = "FORBIDDEN";
    throw err;
  }
  if (scopeOrgId !== actor.organizationId) {
    const err = new Error(
      `${op}: scope.orgId does not match actor.organizationId (cross-tenant guard)`,
    );
    (err as Error & { code: string }).code = "FORBIDDEN";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObjectRecord = {
  id: string;
  type: string;
  parentId: string | null;
  parentType: string | null;
  data: unknown; // caller validates with Zod after reading
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  orgId: string | null;
  // Agent run-context provenance. Populated by objects_save / objects_update
  // from the calling agent's run state (forwarded via the X-Cinatra-* MCP
  // headers and read off mcpRequestContextStorage). All five are nullable for
  // legacy rows and non-agent (user/import) writes.
  source: string | null;
  runId: string | null;
  agentId: string | null;
  packageVersion: string | null;
  agentSpecVersion: string | null;
  // Version is bumped on every UPDATE and feeds the projector's version guard.
  // deletedAt enables soft-delete semantics so reads can skip tombstoned rows.
  // Both default to safe legacy values when the underlying columns are missing.
  version: number;
  deletedAt: string | null;
  // Ownership/scope columns. Backfilled to 'organization' for legacy rows;
  // populated explicitly on save by objects_save. Defaults derive from actor:
  // human writes default to user/userId/private, while system writes default to
  // organization/orgId/organization. Read by enforceResourceAccess.
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: "private" | "team" | "organization" | "public";
  // Nullable project refinement. NULL = pan-project (ambient or substrate).
  // Populated by write-time inheritance from
  // `mcpRequestContextStorage.projectContext`.
  projectId: string | null;
};

export type ReadObjectsOptions = {
  parentId?: string;
  orgId?: string;
};

export type UpsertObjectInput = {
  id?: string; // if omitted, randomUUID() is used
  type: string;
  parentId?: string | null;
  parentType?: string | null;
  data: unknown;
  createdBy?: string | null;
  orgId?: string | null;
  // Agent run-context provenance. Forwarded from `actorExt` in the objects
  // MCP handlers so the shadow PG table is fully queryable by
  // run/agent/version dimensions without going through Graphiti.
  source?: string | null;
  runId?: string | null;
  agentId?: string | null;
  packageVersion?: string | null;
  agentSpecVersion?: string | null;
  // Explicit scope on insert. Optional: when omitted on an upsert that hits
  // the INSERT path, the column DEFAULTs apply (owner_level='organization',
  // visibility='organization', owner_id=NULL until backfilled). Handlers
  // supply these explicitly.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | null;
  ownerId?: string | null;
  visibility?: "private" | "team" | "organization" | "public" | null;
};

// ---------------------------------------------------------------------------
// Row mapping helper
// ---------------------------------------------------------------------------

function rowToObjectRecord(row: Record<string, unknown>): ObjectRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    parentId: (row.parent_id as string | null) ?? null,
    parentType: (row.parent_type as string | null) ?? null,
    data: row.data, // already parsed by pg driver
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    createdBy: (row.created_by as string | null) ?? null,
    orgId: (row.org_id as string | null) ?? null,
    // Provenance columns are nullable. `?? null` is defensive: rows written
    // before the columns existed return undefined for these properties.
    source: (row.source as string | null | undefined) ?? null,
    runId: (row.run_id as string | null | undefined) ?? null,
    agentId: (row.agent_id as string | null | undefined) ?? null,
    packageVersion: (row.package_version as string | null | undefined) ?? null,
    agentSpecVersion: (row.agent_spec_version as string | null | undefined) ?? null,
    // `?? 1` is defensive: legacy rows with no `version` column default to
    // version 1, matching the column DEFAULT 1. `deleted_at` is nullable by
    // definition; ISO-stringify Date instances.
    version:
      typeof row.version === "number"
        ? (row.version as number)
        : ((row.version as number | null | undefined) ?? 1),
    deletedAt:
      row.deleted_at instanceof Date
        ? row.deleted_at.toISOString()
        : ((row.deleted_at as string | null | undefined) ?? null),
    // owner_level / owner_id / visibility surface from the canonical SELECT
    // projections. Defaults match the backfill: organization-owned rows whose
    // owner_id falls back to org_id when the backfill has not yet populated
    // owner_id.
    ownerLevel: normalizeOwnerLevel(row.owner_level),
    ownerId:
      (row.owner_id as string | null | undefined) ??
      (row.org_id as string | null | undefined) ??
      "",
    visibility:
      ((row.visibility as string | null | undefined) ?? "organization") as
        | "private"
        | "team"
        | "organization"
        | "public",
    // Nullable refinement column. Defensive ?? null: not every SELECT
    // projection lists project_id yet (e.g. older callers); the column
    // resolves to undefined → null and the consumer treats the row as
    // pan-project, which matches the intended back-compat semantics.
    projectId: (row.project_id as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// readObjectsByType
// ---------------------------------------------------------------------------

export function readObjectsByType(type: string, opts?: ReadObjectsOptions): ObjectRecord[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const values: unknown[] = [type];
  let whereClause = `WHERE type = $1 AND deleted_at IS NULL`;

  if (opts?.parentId !== undefined) {
    values.push(opts.parentId);
    whereClause += ` AND parent_id = $${values.length}`;
  }
  if (opts?.orgId !== undefined) {
    values.push(opts.orgId);
    whereClause += ` AND org_id = $${values.length}`;
  }

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at, created_by, org_id, source, run_id, agent_id, package_version, agent_spec_version, owner_level, owner_id, visibility
FROM "${schema}"."objects"
${whereClause}`,
        values,
      },
    ],
  });

  return (result?.rows ?? []).map(rowToObjectRecord);
}

// ---------------------------------------------------------------------------
// readAllObjects
// ---------------------------------------------------------------------------

export type ReadAllObjectsOptions = {
  typeIds?: string[];
  orgId?: string;
};

export function readAllObjects(opts?: ReadAllObjectsOptions): ObjectRecord[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const values: unknown[] = [];
  const conditions: string[] = [];

  if (opts?.typeIds && opts.typeIds.length > 0) {
    values.push(opts.typeIds);
    conditions.push(`type = ANY($${values.length}::text[])`);
  }
  if (opts?.orgId !== undefined) {
    values.push(opts.orgId);
    conditions.push(`org_id = $${values.length}`);
  }

  conditions.push("deleted_at IS NULL");
  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at, created_by, org_id, source, run_id, agent_id, package_version, agent_spec_version, owner_level, owner_id, visibility
FROM "${schema}"."objects"
${whereClause}
ORDER BY created_at DESC
LIMIT 200`,
        values,
      },
    ],
  });

  return (result?.rows ?? []).map(rowToObjectRecord);
}

// ---------------------------------------------------------------------------
// readObjectById
// ---------------------------------------------------------------------------

export function readObjectById(id: string): ObjectRecord | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at, created_by, org_id, source, run_id, agent_id, package_version, agent_spec_version, owner_level, owner_id, visibility
FROM "${schema}"."objects"
WHERE id = $1 AND deleted_at IS NULL`,
        values: [id],
      },
    ],
  });

  const row = result?.rows[0];
  if (!row) return null;
  return rowToObjectRecord(row);
}

// ---------------------------------------------------------------------------
// upsertObject
// ---------------------------------------------------------------------------

export function upsertObject(input: UpsertObjectInput): ObjectRecord {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const id = input.id ?? randomUUID();

  // Same inheritance contract as upsertObjectAndEnqueue. `upsertObject` is
  // the legacy asset-blog dual-write entry; it's reachable from inside an
  // agent run via the asset-blog shadow writers, so it must honour the same
  // project frame to avoid leaving asset-blog rows untagged.
  const frame = mcpRequestContextStorage.getStore()?.projectContext;
  const projectIdForRow = resolveProjectInheritanceForType(
    frame?.projectId,
    input.type,
  );

  // Archive gate on the inherited projectId. Substrate writes skip the gate;
  // see upsertObjectAndEnqueue for the rationale.
  if (projectIdForRow !== null) {
    assertProjectWritableSync(projectIdForRow);
  }

  // Provenance columns (source, run_id, agent_id, package_version,
  // agent_spec_version) default to null so callers that omit them keep
  // working unchanged.
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."objects" (id, type, parent_id, parent_type, data, created_by, org_id, source, run_id, agent_id, package_version, agent_spec_version, project_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (id) DO UPDATE SET
  type               = EXCLUDED.type,
  data               = EXCLUDED.data,
  updated_at         = now(),
  parent_id          = EXCLUDED.parent_id,
  parent_type        = EXCLUDED.parent_type,
  created_by         = EXCLUDED.created_by,
  org_id             = EXCLUDED.org_id,
  source             = EXCLUDED.source,
  run_id             = EXCLUDED.run_id,
  agent_id           = EXCLUDED.agent_id,
  package_version    = EXCLUDED.package_version,
  agent_spec_version = EXCLUDED.agent_spec_version,
  -- Preserve established project_id under conflict; only set when a non-NULL
  -- value is being passed in. Explicit project re-tagging is handled by the
  -- move path.
  project_id         = COALESCE(EXCLUDED.project_id, "${schema}"."objects".project_id)
RETURNING id, type, parent_id, parent_type, data, created_at, updated_at, created_by, org_id, source, run_id, agent_id, package_version, agent_spec_version, owner_level, owner_id, visibility, project_id`,
        // pg driver serialises objects to JSONB automatically — do NOT JSON.stringify(input.data)
        values: [
          id,
          input.type,
          input.parentId ?? null,
          input.parentType ?? null,
          input.data,
          input.createdBy ?? null,
          input.orgId ?? null,
          input.source ?? null,
          input.runId ?? null,
          input.agentId ?? null,
          input.packageVersion ?? null,
          input.agentSpecVersion ?? null,
          projectIdForRow, // $13 — inherited project id
        ],
      },
    ],
  });

  const row = result?.rows[0];
  if (!row) throw new Error(`upsertObject: no row returned for id=${id}`);
  return rowToObjectRecord(row);
}

// ---------------------------------------------------------------------------
// deleteObject
// ---------------------------------------------------------------------------

export function deleteObject(id: string): void {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM "${schema}"."objects" WHERE id = $1`,
        values: [id],
      },
    ],
  });
}

export function deleteObjectsByParentId(parentId: string): void {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM "${schema}"."objects" WHERE parent_id = $1`,
        values: [parentId],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Postgres-primary CRUD
// ---------------------------------------------------------------------------
//
// These exports keep the objects MCP write/read paths Postgres-primary, with
// Graphiti relegated to a derived index updated asynchronously via the
// `graphiti_projection_outbox` table.
//
// Atomic-outbox guarantee: the two write functions (`upsertObjectAndEnqueue`
// and `softDeleteObject`) MUST inline both queries in a single
// `runPostgresQueriesSync({ transaction: true, queries: [...] })` call.
// Splitting into two calls breaks the BEGIN/COMMIT bracket; the outbox row
// could silently go missing on a connection error mid-batch.
//
//   The `graphiti_projection_outbox` is a write-only queue consumed by the
//   in-process projector worker (see packages/objects/src/graphiti-projector.ts).
//   It is never read by user-facing handlers. The projector is system-level
//   and does not enforce per-actor authorization; it only projects rows the
//   transaction already committed under canonical-table guards.
//
//   The downstream Graphiti index is *pre-scoped* per organisation by
//   `group_ids: [resolveGroupId(orgId)]` on every search call, making cross-
//   tenant leakage structurally impossible at the index layer. Read sites
//   that surface Graphiti results to users, such as `objects_list` with a
//   query) re-fetch canonical rows from Postgres and re-check authorization
//   via `enforceResourceAccess`. Therefore the outbox does not need to carry
//   `owner_level`/`owner_id`/`visibility`; `org_id` is sufficient for the
//   projector, and authorization is enforced at the canonical Postgres read
//   boundary, not on the derived index.
// ---------------------------------------------------------------------------

/**
 * Canonical object lookup. Enforces org_id scoping and `deleted_at IS NULL`.
 * `orgId === null` means "no org boundary" (system-level reads). Handlers
 * must reject `null` orgId in production before calling this.
 */
export function getObjectById(
  id: string,
  scope: { orgId: string | null },
  actor?: ActorContext,
  options?: { allowDeleted?: boolean },
): ObjectRecord | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  // When an actor is provided, splice buildOwnershipFilter into the WHERE
  // clause so reads scope through the full ownership hierarchy (owner / org /
  // team / project / workspace / admin). Callers reachable from LLM tool
  // calls must pass an actor; handlers fail closed at the entry point.
  let ownershipClause = "";
  let ownershipValues: unknown[] = [];
  if (actor) {
    const frag = buildOwnershipFilter(actor);
    // Remap positional placeholders from $1..$N to $3..$N+2 (after id, orgId).
    ownershipClause = ` AND ${frag.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 2}`)}`;
    ownershipValues = frag.params;
  }

  // `allowDeleted` lets the serve route distinguish "tombstoned but
  // actor-visible" from "actor-denied" so the deleted-allowed pin override
  // only fires for actor-visible tombstones.
  const deletedAtClause = options?.allowDeleted
    ? ""
    : "AND deleted_at IS NULL";

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at,
                 created_by, org_id, source, run_id, agent_id, package_version,
                 agent_spec_version, version, deleted_at,
                 owner_level, owner_id, visibility
               FROM "${schema}"."objects"
               WHERE id = $1
                 AND (org_id = $2 OR $2 IS NULL)
                 ${deletedAtClause}${ownershipClause}
               LIMIT 1`,
        values: [id, scope.orgId, ...ownershipValues],
      },
    ],
  });

  const row = result?.rows[0];
  if (!row) return null;
  return rowToObjectRecord(row);
}

/**
 * Filtered list. Supports an `ids` text[] filter (used by semantic search to
 * fetch the canonical rows for Graphiti-ranked objectIds). When `ids` is
 * provided the SQL uses `id = ANY($n::text[])` and SKIPS implicit `ORDER BY`
 * so the caller can preserve external ranking via `Map<string, ObjectRow>`
 * Without `ids`, results sort by `created_at DESC`.
 */
export type ListObjectsFilter = {
  orgId: string | null;
  type?: string;
  runId?: string;
  ids?: string[];
  limit?: number;
  // Sealed-room filter. When set, the SQL WHERE clause adds
  // `AND project_id = $projectId` so the result contains only rows tagged for
  // this project. Subject to the per-table feature flag
  // (CINATRA_SEALED_ROOM_OBJECTS); when the flag is OFF, this filter is
  // ignored and the call reverts to ambient behavior.
  //
  // The handler should call `assertProjectReadAccess(actor, projectId)`
  // BEFORE passing through to this store; the store does NOT re-authorize
  // (it has no actor for system-internal calls). The 404-hidden gate is
  // a handler-boundary concern; this is the SQL-data-layer half.
  //
  // When both `ids` (Graphiti candidate set) and `projectId` are present,
  // both clauses apply: `id = ANY($ids) AND project_id = $projectId`.
  // Candidates from project Q or ambient are dropped. This intersection is
  // the non-bypassable canonical filter.
  projectId?: string | null;
  // cursor pagination not yet implemented — omitted intentionally
};

export function listObjectsByFilter(
  filter: ListObjectsFilter,
  actor?: ActorContext,
): ObjectRecord[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  const where: string[] = [`(org_id = $1 OR $1 IS NULL)`, `deleted_at IS NULL`];
  const values: unknown[] = [filter.orgId];
  let pIdx = 2;

  if (filter.type) {
    where.push(`type = $${pIdx}`);
    values.push(filter.type);
    pIdx += 1;
  }
  if (filter.runId) {
    where.push(`run_id = $${pIdx}`);
    values.push(filter.runId);
    pIdx += 1;
  }
  if (filter.ids && filter.ids.length > 0) {
    where.push(`id = ANY($${pIdx}::text[])`);
    values.push(filter.ids);
    pIdx += 1;
  }

  // sealedRoomFilterValue() returns the effective projectId, or null when
  // ambient or when the per-table feature flag is OFF. When non-null, append
  // `AND project_id = $projectId` so the result is intersected with the
  // project boundary. This clause runs before the per-actor ownership filter
  // and after the `id IN (...)` clause, so a Graphiti candidate set from
  // P+Q+ambient is filtered down to P-only. The decision lives here in the
  // data layer; handlers can't bypass it.
  const effectiveProjectId = sealedRoomFilterValue("objects", filter.projectId);
  if (effectiveProjectId !== null) {
    where.push(`project_id = $${pIdx}`);
    values.push(effectiveProjectId);
    pIdx += 1;
  }

  // Splice buildOwnershipFilter into WHERE when actor present.
  if (actor) {
    const frag = buildOwnershipFilter(actor);
    const remapped = frag.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + pIdx - 1}`);
    where.push(remapped);
    values.push(...frag.params);
    pIdx += frag.params.length;
  }

  const orderBy =
    filter.ids && filter.ids.length > 0
      ? "" // caller preserves Graphiti rank
      : `ORDER BY created_at DESC`;
  const limitClause = filter.limit
    ? `LIMIT ${Math.min(filter.limit, 1000)}`
    : "LIMIT 100";

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at,
                 created_by, org_id, source, run_id, agent_id, package_version,
                 agent_spec_version, version, deleted_at,
                 owner_level, owner_id, visibility
               FROM "${schema}"."objects"
               WHERE ${where.join(" AND ")}
               ${orderBy}
               ${limitClause}`,
        values,
      },
    ],
  });

  return (result?.rows ?? []).map(rowToObjectRecord);
}

/**
 * Soft-delete: sets `deleted_at` and atomically appends a 'delete' outbox
 * row. NEVER split into two `runPostgresQueriesSync` calls.
 *
 * Conditional outbox via CTE: the CTE below bumps `version`, flips
 * `deleted_at`, and emits the outbox row in the same statement, only when a
 * row actually transitioned. This preserves the atomic-outbox guarantee while
 * eliminating spurious outbox rows for wrong-org or already-deleted updates.
 */
export function softDeleteObject(
  id: string,
  scope: { orgId: string | null },
): { changeSetId: string | null } {
  assertWriteScopeAllowed("softDeleteObject", scope.orgId);
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  // Emit object_change_event in the same atomic CTE so legacy soft-delete
  // callers participate in the data-safety history substrate.
  const legacyChangeSetId = `cs_legacy_${randomUUID()}`;
  const legacyEventId = randomUUID();
  const legacyIdempotencyKey = `che_legacy_${randomUUID()}`;
  const legacyChecksum = createHash("sha256")
    .update(`legacy-writer:softDeleteObject:${id}:${legacyIdempotencyKey}`)
    .digest("hex");

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `WITH base_row AS (
                 SELECT version, row_to_json(o.*)::jsonb AS payload, type, org_id,
                        project_id, owner_level, owner_id, visibility
                 FROM "${schema}"."objects" o WHERE id = $1
               ),
               deleted AS (
                 UPDATE "${schema}"."objects"
                 SET deleted_at = now(),
                     graphiti_sync_status = 'pending',
                     version = COALESCE(version, 0) + 1,
                     updated_at = now()
                 WHERE id = $1
                   AND (org_id = $2 OR $2 IS NULL)
                   AND deleted_at IS NULL
                 RETURNING id, version AS object_version, org_id, type, project_id,
                           owner_level, owner_id, visibility,
                           row_to_json("${schema}"."objects".*)::jsonb AS row_json
               ),
               outbox_row AS (
                 INSERT INTO "${schema}"."graphiti_projection_outbox"
                   (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
                 SELECT gen_random_uuid()::text,
                        deleted.id, deleted.object_version, deleted.org_id,
                        'delete', NULL, 'pending', 0
                 FROM deleted
               ),
               new_changeset AS (
                 INSERT INTO "${schema}"."change_set"
                   (id, org_id, opened_at, actor_id, actor_kind, run_id,
                    effect_rollup, restorable, closed_at, closure_reason,
                    created_by, created_at, updated_at)
                 SELECT $3, deleted.org_id, now(), NULL, 'system', NULL,
                        'reversible-internal', true, now(), 'legacy-writer-auto-close',
                        NULL, now(), now()
                 FROM deleted
                 RETURNING id
               ),
               event_row AS (
                 INSERT INTO "${schema}"."object_change_event"
                   (id, change_set_id, sequence, object_id, object_type, operation,
                    history_effect, before_snapshot, after_snapshot,
                    base_version, result_version, object_schema_version,
                    restore_eligible, restore_ineligible_reason,
                    compensating_template_id, remote_revision_ref,
                    actor_id, actor_kind, run_id, audit_event_id,
                    org_id, project_id, owner_level, owner_id, visibility,
                    idempotency_key, event_checksum, created_at)
                 SELECT $4, $3, 1, deleted.id, deleted.type, 'soft-delete',
                        'reversible-internal',
                        (SELECT payload FROM base_row), deleted.row_json,
                        (SELECT version FROM base_row),
                        deleted.object_version, 'v1',
                        true, NULL, NULL, NULL,
                        NULL, 'system', NULL, NULL,
                        deleted.org_id, deleted.project_id, deleted.owner_level,
                        deleted.owner_id, deleted.visibility,
                        $5, $6, now()
                 FROM deleted
               )
               -- Surface the change_set id ONLY when a row actually transitioned
               -- (new_changeset inserts FROM deleted, so a no-op delete — wrong
               -- org / already-deleted — yields NULL, never an Undo deep-link to a
               -- change_set that was not created).
               SELECT (SELECT id FROM new_changeset) AS change_set_id`,
        values: [
          id,
          scope.orgId,
          legacyChangeSetId,
          legacyEventId,
          legacyIdempotencyKey,
          legacyChecksum,
        ],
      },
    ],
  });
  const changeSetId =
    (result?.rows?.[0]?.change_set_id as string | null | undefined) ?? null;
  return { changeSetId };
}

/**
 * Atomic upsert + outbox enqueue. Two queries inlined in a single
 * `runPostgresQueriesSync({ transaction: true })` call. NEVER split — see
 * the atomic-outbox guarantee above.
 *
 * On INSERT: `version` starts at 1 (column DEFAULT).
 * On UPDATE: version is bumped by one (the outbox row reads the
 * post-UPDATE value via SELECT-after-UPDATE in the second query — safe
 * because the worker source executes queries sequentially inside the
 * transaction).
 *
 * Cross-tenant guard: the `ON CONFLICT DO UPDATE` clause carries a `WHERE`
 * requiring the existing row's `org_id` to match the caller's `org_id`, or
 * either side to be NULL for system-level rows. If a caller from Tenant B
 * supplies an objectId already owned by Tenant A, the WHERE evaluates false,
 * no row is returned by RETURNING, and the `if (!row) throw` fires,
 * preventing silent cross-tenant overwrite. Postgres 9.5+ supports WHERE on
 * DO UPDATE; the deployed Postgres is 13+.
 */
export type UpsertAndEnqueueInput = {
  upsertInput: UpsertObjectInput;
  operation: "upsert" | "delete";
  payloadHash?: string;
};

export function upsertObjectAndEnqueue(
  input: UpsertAndEnqueueInput,
): ObjectRecord & { changeSetId: string } {
  assertWriteScopeAllowed(
    "upsertObjectAndEnqueue",
    input.upsertInput.orgId ?? null,
  );
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const id = input.upsertInput.id ?? randomUUID();

  // Read the active projectContext frame and resolve the projectId to tag:
  // NULL when no frame, NULL when type is substrate, and the frame's projectId
  // otherwise. On non-run paths (chat synchronous tool calls outside an agent
  // run), the frame is whatever the transport boundary set or NULL.
  const frame = mcpRequestContextStorage.getStore()?.projectContext;
  const projectIdForRow = resolveProjectInheritanceForType(
    frame?.projectId,
    input.upsertInput.type,
  );

  // Archive gate. When the resolved projectId is non-NULL, this row is being
  // tagged to the frame's project, not substrate, so assert the project is not
  // archived. The sync gate is a partial-indexed SELECT on projects.archived_at
  // and throws AuthzError(403) when blocked. Substrate writes
  // (projectIdForRow === null) skip the gate because substrate is pan-project
  // and never owned by an archived project even when the run's frame is
  // project-scoped.
  if (projectIdForRow !== null) {
    assertProjectWritableSync(projectIdForRow);
  }

  // Every legacy mutation MUST emit an object_change_event in the same DB
  // transaction as the object mutation + the Graphiti outbox enqueue. The
  // history-coverage check allowlist captures the LEGACY-FACADE call sites; this
  // CTE wires them into the canonical history substrate so no application-level
  // mutation is invisible to the timeline. We auto-open + auto-close an
  // ephemeral change_set per call (legacy callers don't supply one).
  const legacyChangeSetId = `cs_legacy_${randomUUID()}`;
  const legacyEventId = randomUUID();
  const legacyIdempotencyKey = `che_legacy_${randomUUID()}`;
  const legacyChecksum = createHash("sha256")
    .update(`legacy-writer:upsertObjectAndEnqueue:${id}:${legacyIdempotencyKey}`)
    .digest("hex");
  const legacyActorId = input.upsertInput.createdBy ?? null;
  const legacyRunId = input.upsertInput.runId ?? null;

  // Single CTE so the outbox INSERT only fires when the upsert actually wrote
  // a row. This prevents an outbox INSERT when the ON CONFLICT DO UPDATE
  // WHERE guard blocks the update for a cross-tenant collision, which would
  // otherwise let the projector read and project another tenant's data.
  const [upsertResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `WITH base_row AS (
                 SELECT version, row_to_json(o.*)::jsonb AS payload
                 FROM "${schema}"."objects" o WHERE id = $1
               ),
               upserted AS (
                 INSERT INTO "${schema}"."objects"
                   (id, type, parent_id, parent_type, data, created_by, org_id,
                    source, run_id, agent_id, package_version, agent_spec_version,
                    graphiti_sync_status, version,
                    owner_level, owner_id, visibility,
                    project_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', 1,
                         COALESCE($15, 'organization'),
                         COALESCE($16, $7, $6, ''),
                         COALESCE($17, 'organization'),
                         $18)
                 ON CONFLICT (id) DO UPDATE SET
                   type = EXCLUDED.type,
                   data = EXCLUDED.data,
                   parent_id = EXCLUDED.parent_id,
                   parent_type = EXCLUDED.parent_type,
                   created_by = EXCLUDED.created_by,
                   org_id = EXCLUDED.org_id,
                   source = EXCLUDED.source,
                   run_id = EXCLUDED.run_id,
                   agent_id = EXCLUDED.agent_id,
                   package_version = EXCLUDED.package_version,
                   agent_spec_version = EXCLUDED.agent_spec_version,
                   graphiti_sync_status = 'pending',
                   graphiti_projection_error = NULL,
                   version = "${schema}"."objects".version + 1,
                   updated_at = now(),
                   project_id = COALESCE(EXCLUDED.project_id, "${schema}"."objects".project_id)
                 WHERE ("${schema}"."objects".org_id = EXCLUDED.org_id
                        OR "${schema}"."objects".org_id IS NULL
                        OR EXCLUDED.org_id IS NULL)
                 RETURNING id, type, parent_id, parent_type, data, created_at, updated_at,
                   created_by, org_id, source, run_id, agent_id, package_version,
                   agent_spec_version, version, deleted_at,
                   owner_level, owner_id, visibility, project_id
               ),
               outbox_row AS (
                 INSERT INTO "${schema}"."graphiti_projection_outbox"
                   (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
                 SELECT gen_random_uuid()::text,
                        upserted.id, upserted.version, upserted.org_id, $13, $14, 'pending', 0
                 FROM upserted
               ),
               new_changeset AS (
                 INSERT INTO "${schema}"."change_set"
                   (id, org_id, opened_at, actor_id, actor_kind, run_id,
                    effect_rollup, restorable, closed_at, closure_reason,
                    created_by, created_at, updated_at)
                 SELECT $19, upserted.org_id, now(), $20, 'system', $21,
                        'reversible-internal', true, now(), 'legacy-writer-auto-close',
                        $20, now(), now()
                 FROM upserted
                 RETURNING id
               ),
               event_row AS (
                 INSERT INTO "${schema}"."object_change_event"
                   (id, change_set_id, sequence, object_id, object_type, operation,
                    history_effect, before_snapshot, after_snapshot,
                    base_version, result_version, object_schema_version,
                    restore_eligible, restore_ineligible_reason,
                    compensating_template_id, remote_revision_ref,
                    actor_id, actor_kind, run_id, audit_event_id,
                    org_id, project_id, owner_level, owner_id, visibility,
                    idempotency_key, event_checksum, created_at)
                 SELECT $22, $19, 1, upserted.id, upserted.type,
                        CASE WHEN (SELECT version FROM base_row) IS NULL THEN 'create' ELSE 'update' END,
                        'reversible-internal',
                        (SELECT payload FROM base_row),
                        row_to_json(upserted)::jsonb,
                        (SELECT version FROM base_row),
                        upserted.version, 'v1',
                        true, NULL, NULL, NULL,
                        $20, 'system', upserted.run_id, NULL,
                        upserted.org_id, upserted.project_id, upserted.owner_level, upserted.owner_id, upserted.visibility,
                        $23, $24, now()
                 FROM upserted
               )
               SELECT * FROM upserted`,
        values: [
          id,
          input.upsertInput.type,
          input.upsertInput.parentId ?? null,
          input.upsertInput.parentType ?? null,
          input.upsertInput.data,
          input.upsertInput.createdBy ?? null,
          input.upsertInput.orgId ?? null,
          input.upsertInput.source ?? null,
          input.upsertInput.runId ?? null,
          input.upsertInput.agentId ?? null,
          input.upsertInput.packageVersion ?? null,
          input.upsertInput.agentSpecVersion ?? null,
          input.operation,       // $13
          input.payloadHash ?? null, // $14
          input.upsertInput.ownerLevel ?? null, // $15
          input.upsertInput.ownerId ?? null,    // $16
          input.upsertInput.visibility ?? null, // $17
          projectIdForRow,                      // $18 — inherited project id
          legacyChangeSetId,                    // $19 — synthetic change_set id
          legacyActorId,                        // $20 — actor (createdBy or null)
          legacyRunId,                          // $21 — run_id (for change_set.run_id)
          legacyEventId,                        // $22 — event id
          legacyIdempotencyKey,                 // $23 — event idempotency_key
          legacyChecksum,                       // $24 — event checksum
        ],
      },
    ],
  });

  const row = upsertResult?.rows[0];
  if (!row) {
    throw new Error(
      `upsertObjectAndEnqueue: no row returned for id=${id} — possible cross-tenant collision (org_id mismatch on ON CONFLICT DO UPDATE)`,
    );
  }
  // Surface the synthetic legacy change-set id so write callers
  // (objects_update → MutationResult) can offer an Undo. Additive spread on
  // the ObjectRecord: existing field readers (objects_save etc.) are
  // unaffected; the extra `changeSetId` is internal.
  return { ...rowToObjectRecord(row), changeSetId: legacyChangeSetId };
}
