import "server-only";

/**
 * Transactional cascade for project moves.
 *
 * One chokepoint composes:
 *   1) UPDATE on the resource's visible row (`{table}.project_id = $new`).
 *   2) INSERT into `resource_project_moves` (append-only audit) recording
 *      old/new project ids + actor + reason.
 *
 * Both queries run inside ONE
 * `runPostgresQueriesSync({transaction:true})` call so a mid-tx audit
 * failure rolls back the resource row update (atomic rollback is covered by
 * `src/lib/__tests__/resource-project-move.test.ts`).
 *
 * Physical/provenance rows do NOT carry project_id (membership lives on the
 * logical row), so the cascade is JUST the visible row + audit for `objects`
 * and `agent_runs`. The search projection (Graphiti) layer does
 * not carry project_id today either; if it ever does, this helper's signature
 * stays the same and the projector consumes the audit row.
 *
 * The helper is deliberately ORM-free: it composes raw SQL with the
 * caller-supplied schema-qualified table name so the same helper serves
 * every resource type (objects, agent_runs). Each table's
 * primary-key column is also caller-supplied (`idColumn`) — defaults to
 * `id` (current tables use `id`).
 *
 * `agent_run_move_with_outputs` composes this helper differently: a single tx
 * with N+1 UPDATEs (run + N output objects) + N+1 audit rows. See
 * `runAgentRunMoveWithOutputs` for that path.
 */

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { ensurePostgresSchema, postgresSchema, getPostgresConnectionString } from "@/lib/database";
import { randomUUID } from "node:crypto";

export type ResourceKind = "object" | "agent_run" | "project";

export type ResourceProjectMoveArgs = {
  /** Resource row's table (no schema prefix). */
  table: "objects" | "agent_runs" | "projects";
  /** Resource row's primary-key column. Defaults to `id`. */
  idColumn?: string;
  /** Resource row's primary-key value. */
  resourceId: string;
  /** Resource kind for the audit row. */
  resourceKind: ResourceKind;
  /** Current project_id (may be null — ambient → project move). */
  oldProjectId: string | null;
  /** Target project_id (may be null — project → ambient move). */
  newProjectId: string | null;
  /** Authenticated actor id (the user/service that initiated the move). */
  actorId: string;
  /** Optional source-run id for audit lineage. */
  sourceRunId?: string | null;
  /** Optional source-thread id for audit lineage. */
  sourceThreadId?: string | null;
  /** Optional caller-supplied reason annotation (capped at 500 chars). */
  reason?: string | null;
};

/**
 * Build the parameterised UPDATE + INSERT queries used by the move
 * helper. Extracted as a pure builder so unit tests can capture the
 * emitted SQL + values without a live Postgres instance (mirrors the
 * buildChatThreadUpsertQuery pattern).
 */
export function buildResourceProjectMoveQueries(args: ResourceProjectMoveArgs & {
  schemaName: string;
  auditId: string;
}): Array<{ text: string; values: unknown[] }> {
  const schema = args.schemaName.replaceAll('"', '""');
  const table = args.table; // already validated by caller (typed string-union)
  const idCol = args.idColumn ?? "id";

  // UPDATE the visible row's project_id. The WHERE includes the existing
  // project_id check so a concurrent move can't trample our intent
  // (defensive against double-move races).
  const updateQuery = {
    text: `UPDATE "${schema}"."${table}"
              SET project_id = $1
            WHERE ${idCol} = $2
              AND (project_id IS NOT DISTINCT FROM $3)
        RETURNING ${idCol} AS id`,
    values: [args.newProjectId, args.resourceId, args.oldProjectId],
  };

  // INSERT the audit row.
  const auditQuery = {
    text: `INSERT INTO "${schema}"."resource_project_moves"
             (id, resource_kind, resource_id, old_project_id, new_project_id,
              actor_id, source_run_id, source_thread_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      args.auditId,
      args.resourceKind,
      args.resourceId,
      args.oldProjectId,
      args.newProjectId,
      args.actorId,
      args.sourceRunId ?? null,
      args.sourceThreadId ?? null,
      args.reason ?? null,
    ],
  };

  return [updateQuery, auditQuery];
}

/**
 * Execute the project-move cascade in ONE transaction. Throws if the
 * UPDATE matched zero rows (concurrent move race / stale read).
 *
 * Returns the new `resource_project_moves.id` (audit row id) so the
 * caller can surface it in the response envelope.
 */
export function runResourceProjectMove(
  args: ResourceProjectMoveArgs,
): { auditId: string } {
  ensurePostgresSchema();
  const auditId = randomUUID();
  const queries = buildResourceProjectMoveQueries({
    ...args,
    schemaName: postgresSchema,
    auditId,
  });
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries,
  });
  const updateResult = results[0];
  if (!updateResult || updateResult.rowCount === 0) {
    // The UPDATE matched zero rows. This is either:
    //   1) A concurrent move race (someone else moved the row first).
    //   2) The resource was deleted between the existence read and
    //      the move tx (the handler already 404-hid the resource).
    // Either way the entire tx (UPDATE + audit) is rolled back by the
    // worker on the thrown error.
    throw new Error(
      `runResourceProjectMove: zero rows updated for ${args.resourceKind}:${args.resourceId} ` +
        `— possible concurrent move (oldProjectId=${args.oldProjectId})`,
    );
  }
  return { auditId };
}

/**
 * `agent_run_move_with_outputs` cascade.
 *
 * One tx:
 *   1) UPDATE agent_runs.project_id WHERE id = $runId AND project_id IS NOT DISTINCT FROM $old.
 *   2) UPDATE objects.project_id WHERE run_id = $runId.
 *      (Every object created by this run carries `run_id = $runId` — provenance pin set
 *       at insert time by upsertObjectAndEnqueue / upsertObject.)
 *   3) INSERT resource_project_moves audit for the run (resource_kind='agent_run').
 *   4) INSERT one resource_project_moves audit row per moved output object
 *      (resource_kind='object', source_run_id=$runId).
 *
 * Note on per-output audit volume: a run with thousands of outputs will produce thousands
 * of audit rows. This is intentional — the audit table is append-only, indexed by
 * `(resource_kind, resource_id, created_at DESC)`, and the move is a deliberate operator
 * action (not a per-write event). The N+1 audit pattern keeps the audit shape uniform
 * across single-row moves and run-with-outputs moves.
 */
export function runAgentRunMoveWithOutputs(args: {
  runId: string;
  oldProjectId: string | null;
  newProjectId: string | null;
  actorId: string;
  reason?: string | null;
}): { auditId: string; movedOutputIds: string[] } {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const runAuditId = randomUUID();

  // First, gather the list of output ids that WILL move (so we can build per-output
  // audit rows in the same tx). This SELECT runs BEFORE the UPDATEs in the same tx via
  // a single composed query list. The runPostgresQueriesSync API doesn't expose
  // intra-tx result-feeding (each query's values are static), so we structure this as
  // a CTE that emits the moved-output ids AND drives the per-output INSERT in one
  // composite statement.
  //
  // The composed CTE statement does the entire cascade in ONE query:
  //   1. WITH run_update AS (UPDATE agent_runs ... RETURNING id)
  //   2. , obj_update  AS (UPDATE objects ... RETURNING id)
  //   3. , run_audit   AS (INSERT INTO resource_project_moves ... for the RUN)
  //   4. , obj_audit   AS (INSERT INTO resource_project_moves
  //                        SELECT ... FROM obj_update — one row per output)
  //   5. SELECT (run_update.id) AS run_id, (SELECT array_agg(id) FROM obj_update) AS obj_ids
  //
  // Postgres guarantees a single statement is atomic; wrapping it in `transaction:true`
  // is belt-and-braces but does no harm.
  const compositeQuery = {
    text: `WITH run_update AS (
             UPDATE "${schema}"."agent_runs"
                SET project_id = $1
              WHERE id = $2
                AND (project_id IS NOT DISTINCT FROM $3)
              RETURNING id
           ),
           obj_update AS (
             UPDATE "${schema}"."objects"
                SET project_id = $1
              WHERE run_id = $2
                AND EXISTS (SELECT 1 FROM run_update)
              RETURNING id
           ),
           run_audit AS (
             INSERT INTO "${schema}"."resource_project_moves"
               (id, resource_kind, resource_id, old_project_id, new_project_id,
                actor_id, source_run_id, source_thread_id, reason)
             SELECT $4, 'agent_run', $2, $3, $1, $5, $2, NULL, $6
             FROM run_update
             RETURNING id
           ),
           obj_audit AS (
             INSERT INTO "${schema}"."resource_project_moves"
               (id, resource_kind, resource_id, old_project_id, new_project_id,
                actor_id, source_run_id, source_thread_id, reason)
             SELECT gen_random_uuid()::text, 'object', obj_update.id, $3, $1,
                    $5, $2, NULL, $6
             FROM obj_update
             RETURNING id
           )
           SELECT
             (SELECT id FROM run_update) AS run_id,
             COALESCE((SELECT array_agg(id) FROM obj_update), '{}') AS obj_ids,
             (SELECT id FROM run_audit) AS run_audit_id`,
    values: [
      args.newProjectId,
      args.runId,
      args.oldProjectId,
      runAuditId,
      args.actorId,
      args.reason ?? null,
    ],
  };

  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [compositeQuery],
  });
  const row = results[0]?.rows?.[0] as
    | { run_id: string | null; obj_ids: string[] | null; run_audit_id: string | null }
    | undefined;
  if (!row || !row.run_id) {
    throw new Error(
      `runAgentRunMoveWithOutputs: zero rows updated for run ${args.runId} ` +
        `— possible concurrent move (oldProjectId=${args.oldProjectId})`,
    );
  }
  return {
    auditId: row.run_audit_id ?? runAuditId,
    movedOutputIds: row.obj_ids ?? [],
  };
}
