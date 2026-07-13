// Binding reconcile SWEEP + queue consumer + backfill (cinatra#1429, epic #1424).
//
// Three drivers over the per-artifact binding reconcile (binding-write-path.ts):
//
//   - reconcileTypeBindings — the checkpointed, resumable sweep over every
//     object row of a claimed type in a claim scope. Each row is reconciled
//     under its own per-artifact advisory lock; the checkpoint
//     (artifact_binding_backfill_checkpoint) records the id watermark so an
//     interrupted sweep resumes from the last committed batch (AC-5,
//     checkpoint-resumable) and a re-run reconciles every row to ZERO new
//     bindings (AC-5, idempotent — the reconcile is a no-op when the binding
//     already matches the winner).
//
//   - processBindingReconcileQueue — drains the durable
//     'binding-reconcile' work the claim registry enqueues on every winner
//     transition (core__0034). Each queue row names (scope, object_type_id);
//     the consumer sweeps that type, so a winner change reconciles every
//     affected row's binding to the NEW winner (AC-2, the winner-change path).
//     The reconcile always resolves the CURRENT live winner, so a queue item
//     processed late (after a further winner change) still converges.
//
//   - runBindingBackfill — the enrollment backfill: sweep an enrolled type's
//     existing rows to seed their binding assertions (browse-stage activation
//     projects them via the #1427 epoch rebuild). A thin wrapper over
//     reconcileTypeBindings.
//
// Writes ONLY the checkpoint + queue tables (+ the reconcile's semantic_assertion
// writes); reads `objects` to page the sweep. No `objects` mutation.

import "server-only";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { reconcileArtifactBinding } from "@/lib/objects/binding-write-path";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/** scope → the org filter for the object page: an org-scoped claim sweeps that
 * org's rows; a platform-scoped claim sweeps every org's rows of the type (each
 * per-artifact reconcile resolves the org-specific winner, so an org with its
 * own dedicated claim keeps its own binding). */
function scopeOrgFilter(scope: string): string | null {
  return scope.startsWith("org:") ? scope.slice("org:".length) : null;
}

interface CheckpointRow {
  id: string;
  cursor: string | null;
  processed: number;
  inserted: number;
  quarantinedSkipped: number;
  status: string;
}

function mapCheckpoint(r: Record<string, unknown>): CheckpointRow {
  return {
    id: String(r.id),
    cursor: r.cursor_object_id == null ? null : String(r.cursor_object_id),
    processed: Number(r.processed_count),
    inserted: Number(r.inserted_count),
    quarantinedSkipped: Number(r.quarantined_skipped),
    status: String(r.status),
  };
}

/** Open (or resume) the singleton checkpoint for (scope, type, generation). When
 * `restart` is true — a fresh full backfill / re-verification run — the cursor +
 * counts reset; otherwise an existing 'running' checkpoint resumes from its
 * watermark. Returns the current checkpoint state. */
function openCheckpoint(input: {
  scope: string;
  objectTypeId: string;
  generation: number;
  restart: boolean;
}): CheckpointRow {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      {
        text: `INSERT INTO "${q()}"."artifact_binding_backfill_checkpoint"
  (scope, object_type_id, generation, status)
VALUES ($1, $2, $3, 'running')
ON CONFLICT (scope, object_type_id, generation) DO UPDATE SET
  status = 'running',
  updated_at = now(),
  completed_at = NULL,
  cursor_object_id = CASE WHEN $4 THEN NULL ELSE "${q()}"."artifact_binding_backfill_checkpoint".cursor_object_id END,
  processed_count = CASE WHEN $4 THEN 0 ELSE "${q()}"."artifact_binding_backfill_checkpoint".processed_count END,
  inserted_count = CASE WHEN $4 THEN 0 ELSE "${q()}"."artifact_binding_backfill_checkpoint".inserted_count END,
  quarantined_skipped = CASE WHEN $4 THEN 0 ELSE "${q()}"."artifact_binding_backfill_checkpoint".quarantined_skipped END
RETURNING id, cursor_object_id, processed_count, inserted_count, quarantined_skipped, status`,
        values: [input.scope, input.objectTypeId, input.generation, input.restart],
      },
    ],
  });
  return mapCheckpoint((r?.[0]?.rows?.[0] ?? {}) as Record<string, unknown>);
}

function advanceCheckpoint(input: {
  id: string;
  cursor: string;
  addProcessed: number;
  addInserted: number;
  addQuarantined: number;
}): void {
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${q()}"."artifact_binding_backfill_checkpoint"
SET cursor_object_id = $2,
    processed_count = processed_count + $3,
    inserted_count = inserted_count + $4,
    quarantined_skipped = quarantined_skipped + $5,
    updated_at = now()
WHERE id = $1`,
        values: [input.id, input.cursor, input.addProcessed, input.addInserted, input.addQuarantined],
      },
    ],
  });
}

function finishCheckpoint(id: string): void {
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${q()}"."artifact_binding_backfill_checkpoint"
SET status = 'done', completed_at = now(), updated_at = now() WHERE id = $1`,
        values: [id],
      },
    ],
  });
}

/** One page of not-yet-swept object rows of the type (id > cursor), with a
 * quarantine flag. Excludes soft-deleted rows. */
function fetchObjectPage(input: {
  objectTypeId: string;
  orgFilter: string | null;
  cursor: string | null;
  batchSize: number;
}): Array<{ id: string; orgId: string; quarantined: boolean }> {
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.id, o.org_id,
  EXISTS (
    SELECT 1 FROM "${q()}"."object_binding_quarantine" qz
    WHERE qz.org_id = o.org_id AND qz.object_id = o.id) AS quarantined
FROM "${q()}"."objects" o
WHERE o.type = $1
  AND o.deleted_at IS NULL
  AND ($2::text IS NULL OR o.org_id = $2)
  AND ($3::text IS NULL OR o.id > $3)
ORDER BY o.id ASC
LIMIT $4`,
        values: [input.objectTypeId, input.orgFilter, input.cursor, input.batchSize],
      },
    ],
  });
  return ((r?.[0]?.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    orgId: String(row.org_id),
    quarantined: row.quarantined === true,
  }));
}

export interface SweepResult {
  processed: number;
  inserted: number;
  archived: number;
  quarantinedSkipped: number;
  done: boolean;
  cursor: string | null;
  batches: number;
}

/**
 * Sweep every object row of `objectTypeId` in `scope`, reconciling each row's
 * binding under its own advisory lock. Checkpointed + resumable: an interrupted
 * sweep (bounded by `maxBatches`) leaves a 'running' checkpoint whose
 * cursor_object_id is the watermark; a follow-up call with `restart:false`
 * resumes from it. `restart:true` re-runs from the beginning (idempotent —
 * matching bindings insert nothing). Ordering by id makes the watermark total.
 */
export function reconcileTypeBindings(input: {
  scope: string;
  objectTypeId: string;
  generation: number;
  batchSize?: number;
  maxBatches?: number;
  restart?: boolean;
}): SweepResult {
  const batchSize = input.batchSize ?? 200;
  const maxBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  const orgFilter = scopeOrgFilter(input.scope);
  const checkpoint = openCheckpoint({
    scope: input.scope,
    objectTypeId: input.objectTypeId,
    generation: input.generation,
    restart: input.restart ?? false,
  });

  let cursor = checkpoint.cursor;
  let processed = 0;
  let inserted = 0;
  let archived = 0;
  let quarantinedSkipped = 0;
  let batches = 0;
  let done = false;

  while (batches < maxBatches) {
    const page = fetchObjectPage({
      objectTypeId: input.objectTypeId,
      orgFilter,
      cursor,
      batchSize,
    });
    if (page.length === 0) {
      finishCheckpoint(checkpoint.id);
      done = true;
      break;
    }
    let batchInserted = 0;
    let batchArchived = 0;
    let batchQuarantined = 0;
    for (const obj of page) {
      const res = reconcileArtifactBinding({ orgId: obj.orgId, artifactId: obj.id });
      batchInserted += res.inserted;
      batchArchived += res.archived;
      if (obj.quarantined) batchQuarantined += 1;
      cursor = obj.id;
    }
    processed += page.length;
    inserted += batchInserted;
    archived += batchArchived;
    quarantinedSkipped += batchQuarantined;
    batches += 1;
    advanceCheckpoint({
      id: checkpoint.id,
      cursor: cursor!,
      addProcessed: page.length,
      addInserted: batchInserted,
      addQuarantined: batchQuarantined,
    });
    if (page.length < batchSize) {
      finishCheckpoint(checkpoint.id);
      done = true;
      break;
    }
  }

  return { processed, inserted, archived, quarantinedSkipped, done, cursor, batches };
}

/**
 * Enrollment backfill: seed binding assertions for an enrolled type's existing
 * rows. A full, idempotent run (restart:true re-verifies to zero new rows).
 */
export function runBindingBackfill(input: {
  scope: string;
  objectTypeId: string;
  generation: number;
  batchSize?: number;
  restart?: boolean;
}): SweepResult {
  return reconcileTypeBindings({
    scope: input.scope,
    objectTypeId: input.objectTypeId,
    generation: input.generation,
    batchSize: input.batchSize,
    restart: input.restart ?? true,
  });
}

export interface QueueDrainResult {
  processed: number;
  failed: number;
}

/** Max reconcile attempts before a queue row is parked as terminal 'failed'
 * (the artifact_binding_reconcile_queue status vocabulary is fixed to
 * pending|done|failed by core__0034; a transient failure stays 'pending' with a
 * bumped attempts count so a later drain retries — only a persistently-failing
 * row parks). */
const MAX_QUEUE_ATTEMPTS = 5;

/**
 * Drain pending 'binding-reconcile' work the claim registry enqueued on winner
 * transitions. Each row names (scope, object_type_id); we resolve its generation
 * from the claim event and sweep the type, so every affected row's binding
 * reconciles to the current winner. A row that errors is marked 'failed'
 * (attempts incremented) and skipped; the sweep is idempotent so a retry is
 * safe. Returns the counts.
 */
export function processBindingReconcileQueue(input?: { limit?: number }): QueueDrainResult {
  ensurePostgresSchema();
  const limit = input?.limit ?? 50;
  // FOR UPDATE SKIP LOCKED so concurrent drains never grab the same rows (the
  // reconcile is idempotent, but this avoids redundant sweeps). The claim runs
  // in its own tx; the per-row reconcile opens its own advisory-locked tx.
  const pending = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      {
        text: `SELECT rq.id, rq.scope, rq.object_type_id, rq.attempts, ev.generation
FROM "${q()}"."artifact_binding_reconcile_queue" rq
LEFT JOIN "${q()}"."artifact_claim_events" ev ON ev.id = rq.claim_event_id
WHERE rq.kind = 'binding-reconcile' AND rq.status = 'pending'
ORDER BY rq.created_at ASC
LIMIT $1
FOR UPDATE OF rq SKIP LOCKED`,
        values: [limit],
      },
    ],
  });
  let processed = 0;
  let failed = 0;
  for (const row of (pending?.[0]?.rows ?? []) as Array<Record<string, unknown>>) {
    const id = String(row.id);
    const scope = String(row.scope);
    const objectTypeId = String(row.object_type_id);
    const generation = row.generation == null ? 0 : Number(row.generation);
    const attempts = row.attempts == null ? 0 : Number(row.attempts);
    try {
      reconcileTypeBindings({ scope, objectTypeId, generation, restart: true });
      runPostgresQueriesSync({
        connectionString: conn(),
        queries: [
          {
            text: `UPDATE "${q()}"."artifact_binding_reconcile_queue"
SET status = 'done', processed_at = now() WHERE id = $1`,
            values: [id],
          },
        ],
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A transient failure stays 'pending' (retryable) until MAX_QUEUE_ATTEMPTS;
      // only a persistently-failing row parks as terminal 'failed'.
      const nextStatus = attempts + 1 >= MAX_QUEUE_ATTEMPTS ? "failed" : "pending";
      runPostgresQueriesSync({
        connectionString: conn(),
        queries: [
          {
            text: `UPDATE "${q()}"."artifact_binding_reconcile_queue"
SET status = $3, attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            values: [id, message.slice(0, 2000), nextStatus],
          },
        ],
      });
      failed += 1;
    }
  }
  return { processed, failed };
}
