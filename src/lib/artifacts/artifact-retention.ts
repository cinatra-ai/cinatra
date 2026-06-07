import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { countArtifactRefs } from "./artifact-refs-store";

// Semantic-aware retention, tombstone, and GC.
//
// Retention is resource-keyed because under semantic substance-dedupe a
// single resource can back multiple artifacts.
//
// Preserve the replay-safe pin contract. `artifact_refs` is the pin
// table; tombstone of an artifact respects the retention window when
// refs exist.
//
// Invariants:
//  - A tombstoned artifact's bytes stay reachable through pinned
//    representation revisions until BOTH retention elapses AND no
//    pin remains.
//  - The append-only `representation` table is NOT mutated by GC.
//    Representation rows persist forever for replay safety.
//  - Physical GC reclaims at the RESOURCE level: when no live
//    representation references a resource AND the resource has no
//    artifact_refs pin AND retention elapsed, the resource row +
//    artifact_blobs row + on-disk bytes are reclaimed together.
//  - Once a resource is GC'd, future same-substance uploads MINT
//    a fresh resource (the unique index allows because the old
//    row was deleted).

export type ArtifactAuditAction =
  | "create"
  | "tombstone"
  | "transfer"
  | "promote"
  | "gc";

const REFERENCED_RETENTION_DAYS = 30;

/** Append-only audit row. */
export function writeArtifactAudit(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId?: string | null;
  action: ArtifactAuditAction;
  actor?: string | null;
  detail?: Record<string, unknown>;
}): void {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values: [
          randomUUID(),
          input.orgId,
          input.artifactId,
          input.representationRevisionId ?? null,
          input.action,
          input.actor ?? null,
          input.detail ?? {},
        ],
      },
    ],
  });
}

/**
 * Tombstone an artifact: soft-delete via `objects.deleted_at`. If
 * any `artifact_refs` row pins the artifact, push `retain_until` to
 * `now() + 30 days` on each affected resource (via metadata) using
 * GREATEST semantics so a SHORTER retention from another concurrent
 * tombstone never overrides a longer one.
 *
 * Also invalidates the provider-cache rows for this artifact: a
 * tombstoned artifact's provider file id must NOT be replayed to the
 * LLM.
 *
 * Returns the pin count seen at tombstone time.
 */
export function tombstoneArtifact(input: {
  orgId: string;
  artifactId: string;
  actor?: string | null;
}): { referenced: boolean; pinCount: number } {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const pinCount = countArtifactRefs(input.orgId, input.artifactId);
  const referenced = pinCount > 0;

  // Audit BEFORE the destructive step (write-before-destroy).
  writeArtifactAudit({
    orgId: input.orgId,
    artifactId: input.artifactId,
    action: "tombstone",
    actor: input.actor,
    detail: { referenced, pinCount },
  });

  const retainDays = referenced ? REFERENCED_RETENTION_DAYS : 0;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      // Soft-delete the artifact's object row.
      {
        text: `UPDATE "${schema}"."objects"
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
        values: [input.artifactId, input.orgId],
      },
      // Mark `retain_until` on every resource backing this artifact.
      // Use GREATEST semantics so a shared-resource tombstone with a
      // SHORTER retention can never override a longer one. The new
      // retain_until is computed in SQL and compared (as timestamptz)
      // to the existing value (if any).
      {
        text: `UPDATE "${schema}"."resource" r
SET metadata = r.metadata || jsonb_build_object(
  'retain_until',
  GREATEST(
    (now() + ($3 || ' days')::interval),
    NULLIF(r.metadata->>'retain_until','')::timestamptz
  )::text
)
WHERE r.org_id = $2
  AND r.id IN (
    SELECT rep.resource_id FROM "${schema}"."representation" rep
    WHERE rep.org_id = $2 AND rep.artifact_id = $1
  )`,
        values: [input.artifactId, input.orgId, String(retainDays)],
      },
      // Invalidate provider-cache rows for this artifact. Per-artifact
      // key; emits NO new provider uploads post-tombstone.
      {
        text: `DELETE FROM "${schema}"."artifact_provider_cache"
WHERE org_id = $2 AND artifact_id = $1`,
        values: [input.artifactId, input.orgId],
      },
    ],
  });
  return { referenced, pinCount };
}

/**
 * Resource-level physical GC. Reclaims `artifact_blobs` rows + their
 * on-disk bytes + the `resource` row for resources whose parent
 * representations all belong to tombstoned objects AND have no
 * `artifact_refs` pin AND have an elapsed `retain_until`.
 *
 * Append-only `representation` rows are NOT deleted for replay safety.
 * They become unservable (resource_id JOIN comes up empty → null) —
 * correct behavior for a GC'd substance.
 *
 * The per-resource transaction RECHECKS the full eligibility predicate
 * at every destructive step: both the artifact_blobs DELETE and the
 * resource DELETE are gated by the same NOT EXISTS subqueries. If a
 * ref/active-representation/non-elapsed-retention appears between
 * SELECT and the held-lock tx, both DELETEs no-op and the resource
 * survives.
 */
export async function runResourceBlobGc(opts?: {
  orgId?: string;
  limit?: number;
}): Promise<{ reclaimed: number }> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
  const orgFilter = opts?.orgId ? "AND r.org_id = $1" : "";

  // ELIGIBILITY predicate (kept inline in both the candidate SELECT
  // below and the under-lock CTE recheck further down). Keep the
  // predicates byte-for-byte identical so the under-lock recheck
  // cannot drift from the candidate-picker.
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT DISTINCT r.id, r.org_id, r.metadata->>'storageKey' AS storage_key, r.metadata->>'blobId' AS blob_id
FROM "${schema}"."resource" r
WHERE r.kind = 'blob'
  ${orgFilter}
  AND EXISTS (
    SELECT 1 FROM "${schema}"."representation" rep
    WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM "${schema}"."representation" rep
    JOIN "${schema}"."objects" o
      ON o.id = rep.artifact_id AND o.org_id = rep.org_id
    WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
      AND o.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "${schema}"."artifact_refs" ar
    JOIN "${schema}"."representation" rep
      ON rep.artifact_id = ar.artifact_id
       AND rep.id = ar.representation_revision_id
       AND rep.org_id = ar.org_id
    WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
  )
  AND (
    r.metadata->>'retain_until' IS NULL
    OR (r.metadata->>'retain_until')::timestamptz < now()
  )
LIMIT ${limit}`,
        values: opts?.orgId ? [opts.orgId] : [],
      },
    ],
  });
  const rows = (res?.rows ?? []) as Array<{
    id: string;
    org_id: string;
    storage_key: string | null;
    blob_id: string | null;
  }>;
  const store = createLocalDiskBlobStore();
  let reclaimed = 0;
  for (const row of rows) {
    if (!row.storage_key) continue;
    try {
      // Pack the entire reclaim into ONE SQL STATEMENT (single CTE
      // chain) so all sub-operations share the SAME PostgreSQL
      // snapshot. Eligibility is computed once in the `eligible` CTE;
      // blob DELETE + audit INSERT + resource DELETE all JOIN to that
      // CTE. If a concurrent writer commits a new
      // pin/representation/retain_until BETWEEN the candidate SELECT
      // (outer loop) and this statement, the `eligible` CTE
      // re-evaluates the predicate and returns 0 rows → ALL DELETEs
      // and the audit no-op atomically. The advisory lock prevents
      // same-resource GC concurrency from racing on the same row.
      const [, delResRes] = runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries: [
          {
            text: `SELECT pg_advisory_xact_lock(hashtext($1))`,
            values: [row.id],
          },
          {
            text: `WITH eligible AS (
  SELECT r.id, r.org_id,
         r.metadata->>'storageKey' AS storage_key,
         r.metadata->>'blobId' AS blob_id
  FROM "${schema}"."resource" r
  WHERE r.id = $1 AND r.org_id = $2 AND r.kind = 'blob'
    AND EXISTS (
      SELECT 1 FROM "${schema}"."representation" rep
      WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM "${schema}"."representation" rep
      JOIN "${schema}"."objects" o
        ON o.id = rep.artifact_id AND o.org_id = rep.org_id
      WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
        AND o.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "${schema}"."artifact_refs" ar
      JOIN "${schema}"."representation" rep
        ON rep.artifact_id = ar.artifact_id
         AND rep.id = ar.representation_revision_id
         AND rep.org_id = ar.org_id
      WHERE rep.resource_id = r.id AND rep.org_id = r.org_id
    )
    AND (
      r.metadata->>'retain_until' IS NULL
      OR (r.metadata->>'retain_until')::timestamptz < now()
    )
),
del_blob AS (
  DELETE FROM "${schema}"."artifact_blobs" b
  USING eligible
  WHERE b.id = eligible.blob_id AND b.org_id = eligible.org_id
  RETURNING b.id
),
aud AS (
  INSERT INTO "${schema}"."artifact_audit"
    (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
  SELECT gen_random_uuid()::text, rep.org_id, rep.artifact_id, rep.id,
         'gc', NULL,
         jsonb_build_object(
           'resourceId', eligible.id,
           'blobId', eligible.blob_id,
           'storageKey', eligible.storage_key
         )
  FROM "${schema}"."representation" rep
  JOIN eligible ON rep.resource_id = eligible.id AND rep.org_id = eligible.org_id
  RETURNING id
)
DELETE FROM "${schema}"."resource" r
USING eligible
WHERE r.id = eligible.id AND r.org_id = eligible.org_id
RETURNING r.id`,
            values: [row.id, row.org_id],
          },
        ],
      });
      // Destructure the RIGHT statement's result. [, delResRes] picks
      // index 1 (the CTE statement with final RETURNING r.id from the
      // resource DELETE). The single-CTE design guarantees:
      // rows.length > 0 ⇒ EVERYTHING reclaimed (blob deleted, audit
      // written, resource deleted) atomically. rows.length === 0 ⇒
      // predicate raced; NOTHING was reclaimed.
      //
      // Known limitation: a concurrent pin INSERT can commit AFTER our
      // CTE's snapshot but BEFORE our tx commits, leaving a pin row
      // pointing at a representation whose resource is about to be
      // reclaimed. PostgreSQL READ COMMITTED + the single-CTE snapshot
      // do NOT serialize against external writers that don't coordinate
      // on the same resource-level lock. Proper fix would require
      // pin/representation writers to take `pg_advisory_xact_lock(
      // hashtext(resource_id))` for every affected resource — a
      // substantial expansion since pin writers don't have direct
      // resource_id access (they pin by artifactId + representation
      // revision). Mitigation: the affected pin row points at orphaned
      // bytes; the route serve will 404; the pin-emitting consumer
      // (chat / WayFlow / agent-run) can re-upload. Race-window size:
      // bounded by the held-lock tx duration (~ms).
      const resourceReclaimed = (delResRes?.rows?.length ?? 0) > 0;
      if (resourceReclaimed) {
        // Physical byte delete (best-effort; the resource row deletion
        // committed; a crash here leaves a disk orphan that the
        // filesystem-sweep companion would clean. The on-disk bytes
        // are no longer reachable through any DB row.)
        await store
          .deleteByStorageKey({
            orgId: row.org_id,
            storageKey: row.storage_key,
          })
          .catch(() => {});
        reclaimed += 1;
      }
    } catch {
      // Log + continue; a single resource failure must not block the
      // batch. Keep this conservative; full operational GC observability
      // belongs in the surrounding job/telemetry layer.
    }
  }
  return { reclaimed };
}

/**
 * @deprecated Kept as a compatibility alias for `runResourceBlobGc` to
 * ease external-importer transition.
 */
export const runOrphanBlobGc = runResourceBlobGc;
