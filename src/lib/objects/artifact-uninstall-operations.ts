// Artifact-extension uninstall-operation store (cinatra#1432, epic #1424) —
// the DB primitives behind REPLAYABLE uninstall archival:
//
//   UNINSTALL: archive the uninstalled extension's ELIGIBLE semantic
//   assertions in CHECKPOINTED per-artifact batches under an operation
//   record. Each artifact is one held-lock transaction — the SAME
//   per-artifact advisory lock + floor-rebalance + Graphiti-refresh tail the
//   assertion service uses (buildFloorRebalanceAndRefreshQueries), so an
//   artifact never loses its last eligible identity (the floor re-asserts)
//   and the projector stays in lock-step. The archive UPDATE and the lineage
//   INSERT are ONE data-modifying-CTE statement, so the lineage is
//   exactly-the-archived-set by construction.
//
//   REINSTALL: replay INSERTS replacement CLASSIC assertions for EXACTLY the
//   set the operation archived (archived rows are never un-archived — the
//   semantic_assertion frozen trigger forbids resurrection; replay is always
//   a new INSERT). Idempotent + type-changed-while-absent-safe: the insert is
//   guarded on the artifact still existing and on NO live same-extension
//   assertion (the sa_active_unique_idx invariant), and the floor rebalance
//   in the same transaction archives a now-redundant default. Binding-basis
//   rows are NOT replayed as bindings: bindings always REGENERATE from
//   current claims + the current object type via the
//   artifact_binding_reconcile_queue rows the claim activation enqueued
//   (consumer: the binding write-path sub-issue cinatra#1429).
//
// Interrupted archival RESUMES: the operation row carries a jsonb checkpoint
// cursor; re-running skips already-archived artifacts (no eligible rows
// left) and the lineage UNIQUE (operation_id, assertion_id) absorbs any
// overlap. Sync leaf like artifact-claim-store.ts (composes into the
// synchronous store graph).

import { randomUUID } from "node:crypto";

import { isDefaultArtifactType } from "@cinatra-ai/objects";

import { buildFloorRebalanceAndRefreshQueries } from "@/lib/artifacts/semantic-assertion-store";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

type QueryInput = { text: string; values?: unknown[] };

function q(): string {
  return postgresSchema.replaceAll('"', '""');
}

function run(queries: QueryInput[], transaction = false) {
  ensurePostgresSchema();
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction,
    queries,
  });
}

export interface ArtifactUninstallOperationRow {
  id: string;
  scope: string;
  extensionPackage: string;
  extensionVersion: string;
  actor: string;
  status: "running" | "completed" | "failed";
  archivedCount: number;
  checkpoint: unknown;
  replayedAt: string | null;
  replayedInstallId: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

function mapOperationRow(r: Record<string, unknown>): ArtifactUninstallOperationRow {
  return {
    id: String(r.id),
    scope: String(r.scope),
    extensionPackage: String(r.extension_package),
    extensionVersion: String(r.extension_version),
    actor: String(r.actor),
    status: String(r.status) as ArtifactUninstallOperationRow["status"],
    archivedCount: Number(r.archived_count),
    checkpoint: r.checkpoint ?? null,
    replayedAt: r.replayed_at == null ? null : String(r.replayed_at),
    replayedInstallId: r.replayed_install_id == null ? null : String(r.replayed_install_id),
    createdAt: r.created_at == null ? null : String(r.created_at),
    completedAt: r.completed_at == null ? null : String(r.completed_at),
  };
}

const OPERATION_COLUMNS =
  "id, scope, extension_package, extension_version, actor, status, archived_count, checkpoint, replayed_at, replayed_install_id, created_at, completed_at";

/** Open an uninstall-operation record (status 'running'). */
export function beginArtifactUninstallOperation(input: {
  scope: string;
  extensionPackage: string;
  extensionVersion: string;
  actor: string;
}): string {
  const id = randomUUID();
  run([
    {
      text: `INSERT INTO "${q()}"."artifact_uninstall_operations"
        (id, scope, extension_package, extension_version, actor)
        VALUES ($1, $2, $3, $4, $5)`,
      values: [id, input.scope, input.extensionPackage, input.extensionVersion, input.actor],
    },
  ]);
  return id;
}

/** The org filter an operation's scope implies: `org:<id>` → that org;
 * 'platform' → every org (no filter). */
function scopeOrgFilter(scope: string): { clause: string; values: unknown[] } {
  if (scope.startsWith("org:")) {
    return { clause: `AND org_id = $2`, values: [scope.slice("org:".length)] };
  }
  return { clause: "", values: [] };
}

/** One data-modifying CTE: archive the extension's ELIGIBLE assertions on ONE
 * artifact and write the lineage rows from the archived set. Exported for the
 * SQL-shape tests. */
export function buildArchiveArtifactAssertionsWithLineageQuery(
  schemaName: string,
  input: { operationId: string; orgId: string; artifactId: string; extension: string },
): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH archived AS (
        UPDATE "${s}"."semantic_assertion"
        SET eligibility = 'archived', archived_at = now()
        WHERE org_id = $1 AND artifact_id = $2 AND extension = $3 AND eligibility = 'eligible'
        RETURNING id, org_id, artifact_id, extension, asserted_by, asserted_by_principal
      )
      INSERT INTO "${s}"."artifact_uninstall_operation_assertions"
        (operation_id, assertion_id, org_id, artifact_id, extension, asserted_by, asserted_by_principal)
      SELECT $4, a.id, a.org_id, a.artifact_id, a.extension, a.asserted_by, a.asserted_by_principal
      FROM archived a
      ON CONFLICT (operation_id, assertion_id) DO NOTHING
      RETURNING assertion_id`,
    values: [input.orgId, input.artifactId, input.extension, input.operationId],
  };
}

/**
 * Run the checkpointed archival for an open operation: walk the extension's
 * artifacts (scope-filtered) in (org_id, artifact_id) order past the stored
 * checkpoint, archiving each artifact's eligible assertions + writing lineage
 * + floor-rebalancing in ONE held-lock transaction per artifact, then advance
 * the checkpoint after every batch. Marks the operation 'completed' when the
 * walk ends. Re-entrant: a crashed run resumes from the checkpoint.
 */
export function runArtifactUninstallArchival(input: {
  operationId: string;
  batchSize?: number;
}): { archivedAssertions: number; processedArtifacts: number } {
  const batchSize = Math.max(1, input.batchSize ?? 25);
  const [opResult] = run([
    {
      text: `SELECT ${OPERATION_COLUMNS} FROM "${q()}"."artifact_uninstall_operations" WHERE id = $1`,
      values: [input.operationId],
    },
  ]);
  if (opResult.rows.length === 0) {
    throw new Error(`artifact uninstall operation '${input.operationId}' not found`);
  }
  const op = mapOperationRow(opResult.rows[0]);
  if (op.status !== "running") {
    return { archivedAssertions: 0, processedArtifacts: 0 };
  }
  if (isDefaultArtifactType(op.extensionPackage)) {
    // Defensive: the floor extension is uninstall-protected upstream; its
    // assertions are owned exclusively by the floor rebalance.
    throw new Error("the default-artifact floor extension's assertions are never archived by uninstall");
  }
  const filter = scopeOrgFilter(op.scope);
  let cursor =
    op.checkpoint != null &&
    typeof op.checkpoint === "object" &&
    typeof (op.checkpoint as { orgId?: unknown }).orgId === "string" &&
    typeof (op.checkpoint as { artifactId?: unknown }).artifactId === "string"
      ? (op.checkpoint as { orgId: string; artifactId: string })
      : null;
  let archivedAssertions = 0;
  let processedArtifacts = 0;
  // Foreground batch loop — each iteration reads the next artifact batch,
  // processes each artifact in its own held-lock tx, then checkpoints.
  for (;;) {
    const cursorClause = cursor ? `AND (org_id, artifact_id) > ($${filter.values.length + 2}, $${filter.values.length + 3})` : "";
    const [batch] = run([
      {
        text: `SELECT DISTINCT org_id, artifact_id FROM "${q()}"."semantic_assertion"
               WHERE extension = $1 AND eligibility = 'eligible' ${filter.clause} ${cursorClause}
               ORDER BY org_id, artifact_id
               LIMIT ${batchSize}`,
        values: cursor
          ? [op.extensionPackage, ...filter.values, cursor.orgId, cursor.artifactId]
          : [op.extensionPackage, ...filter.values],
      },
    ]);
    if (batch.rows.length === 0) break;
    // Per-batch delta: `archived_count` is incremented by THIS batch's archived
    // count only (the running total lives in `archivedAssertions`); passing the
    // cumulative total here would double-count on every subsequent batch.
    let batchArchived = 0;
    for (const row of batch.rows) {
      const orgId = String(row.org_id);
      const artifactId = String(row.artifact_id);
      const results = run(
        [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
          buildArchiveArtifactAssertionsWithLineageQuery(postgresSchema, {
            operationId: input.operationId,
            orgId,
            artifactId,
            extension: op.extensionPackage,
          }),
          // Floor tail: the uninstalled extension's identity is gone, so the
          // rebalance re-asserts the default when nothing eligible remains.
          // 'user' is a placeholder rank source for the floor INSERT's
          // asserted_by (the floor row is system-owned either way).
          ...buildFloorRebalanceAndRefreshQueries(orgId, artifactId, "user"),
        ],
        true,
      );
      batchArchived += results[1].rowCount;
      processedArtifacts += 1;
    }
    archivedAssertions += batchArchived;
    const last = batch.rows[batch.rows.length - 1];
    cursor = { orgId: String(last.org_id), artifactId: String(last.artifact_id) };
    run([
      {
        text: `UPDATE "${q()}"."artifact_uninstall_operations"
               SET checkpoint = $2::jsonb, archived_count = archived_count + $3, updated_at = now()
               WHERE id = $1`,
        values: [input.operationId, JSON.stringify(cursor), batchArchived],
      },
    ]);
    if (batch.rows.length < batchSize) break;
  }
  run([
    {
      text: `UPDATE "${q()}"."artifact_uninstall_operations"
             SET status = 'completed', completed_at = now(), updated_at = now()
             WHERE id = $1 AND status = 'running'`,
      values: [input.operationId],
    },
  ]);
  return { archivedAssertions, processedArtifacts };
}

/** The LATEST completed, not-yet-replayed operation for (scope, package) —
 * the set a reinstall is owed. */
export function findReplayableUninstallOperation(input: {
  scope: string;
  extensionPackage: string;
}): ArtifactUninstallOperationRow | null {
  const [result] = run([
    {
      text: `SELECT ${OPERATION_COLUMNS} FROM "${q()}"."artifact_uninstall_operations"
             WHERE extension_package = $1 AND scope = $2 AND status = 'completed' AND replayed_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1`,
      values: [input.extensionPackage, input.scope],
    },
  ]);
  return result.rows.length > 0 ? mapOperationRow(result.rows[0]) : null;
}

/** Replacement-classic INSERT for one archived-lineage assertion. Guards:
 * the artifact still exists (org-scoped) AND no live same-extension assertion
 * exists (idempotency + the sa_active_unique_idx invariant). assertion_basis
 * defaults to 'classic' — replay NEVER writes binding-basis rows. Exported
 * for the SQL-shape tests. */
export function buildReplayReplacementAssertionQuery(
  schemaName: string,
  input: {
    orgId: string;
    artifactId: string;
    extension: string;
    assertedBy: string;
    assertedByPrincipal: string | null;
  },
): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."semantic_assertion"
  (id, org_id, artifact_id, extension, asserted_by, eligibility, asserted_by_principal)
SELECT $6::text, $1::text, $2::text, $3::text, $4::text, 'eligible', $5::text
WHERE EXISTS (
  SELECT 1 FROM "${s}"."objects" o WHERE o.id = $2::text AND o.org_id = $1::text)
AND NOT EXISTS (
  SELECT 1 FROM "${s}"."semantic_assertion" sa
   WHERE sa.org_id = $1::text AND sa.artifact_id = $2::text AND sa.extension = $3::text AND sa.eligibility <> 'archived')
RETURNING id`,
    values: [
      input.orgId,
      input.artifactId,
      input.extension,
      input.assertedBy,
      input.assertedByPrincipal,
      randomUUID(),
    ],
  };
}

/**
 * Reinstall replay: INSERT replacement classic assertions for EXACTLY the
 * operation's archived set (per-artifact held-lock transactions with the
 * floor tail), then mark the operation replayed. At-most-once per operation:
 * the final CAS (`replayed_at IS NULL`) records the consuming install.
 * Type-changed-while-absent safety: replay never resurrects archived rows and
 * never displaces a live same-extension assertion; bindings regenerate from
 * CURRENT claims + the CURRENT object type via the reconcile queue, not here.
 */
export function replayArtifactUninstallOperation(input: {
  operationId: string;
  installId: string | null;
  batchSize?: number;
}): { insertedAssertions: number; skipped: number } {
  const batchSize = Math.max(1, input.batchSize ?? 100);
  let insertedAssertions = 0;
  let skipped = 0;
  let offsetCursor: { orgId: string; artifactId: string; assertionId: string } | null = null;
  for (;;) {
    const cursorClause = offsetCursor
      ? `AND (org_id, artifact_id, assertion_id) > ($2, $3, $4)`
      : "";
    const [batch] = run([
      {
        text: `SELECT assertion_id, org_id, artifact_id, extension, asserted_by, asserted_by_principal
               FROM "${q()}"."artifact_uninstall_operation_assertions"
               WHERE operation_id = $1 ${cursorClause}
               ORDER BY org_id, artifact_id, assertion_id
               LIMIT ${batchSize}`,
        values: offsetCursor
          ? [input.operationId, offsetCursor.orgId, offsetCursor.artifactId, offsetCursor.assertionId]
          : [input.operationId],
      },
    ]);
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      const orgId = String(row.org_id);
      const artifactId = String(row.artifact_id);
      const extension = String(row.extension);
      if (isDefaultArtifactType(extension)) {
        // Defensive: the floor is owned by the rebalance, never replayed.
        skipped += 1;
        continue;
      }
      const results = run(
        [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
          buildReplayReplacementAssertionQuery(postgresSchema, {
            orgId,
            artifactId,
            extension,
            assertedBy: String(row.asserted_by),
            assertedByPrincipal:
              row.asserted_by_principal == null ? null : String(row.asserted_by_principal),
          }),
          ...buildFloorRebalanceAndRefreshQueries(orgId, artifactId, "user"),
        ],
        true,
      );
      if (results[1].rowCount > 0) insertedAssertions += 1;
      else skipped += 1;
    }
    const last = batch.rows[batch.rows.length - 1];
    offsetCursor = {
      orgId: String(last.org_id),
      artifactId: String(last.artifact_id),
      assertionId: String(last.assertion_id),
    };
    if (batch.rows.length < batchSize) break;
  }
  run([
    {
      text: `UPDATE "${q()}"."artifact_uninstall_operations"
             SET replayed_at = now(), replayed_install_id = $2, updated_at = now()
             WHERE id = $1 AND replayed_at IS NULL`,
      values: [input.operationId, input.installId],
    },
  ]);
  return { insertedAssertions, skipped };
}
