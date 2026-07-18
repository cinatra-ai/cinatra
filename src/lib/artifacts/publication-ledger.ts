import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

import { getRepresentationByIdForReplay } from "./representation-store";
import {
  deriveIdempotencyKey,
  type PublicationDestination,
} from "./publication-operation-state";
import type {
  PublicationOperationRow,
  PublicationReceipt,
} from "./publication-ledger-types";
import {
  NOOP_PUBLICATION_STATUS_PORT,
  type PublicationStatusContext,
  type PublicationStatusPort,
} from "./publication-status-port";

// ---------------------------------------------------------------------------
// Durable publication-operation ledger (cinatra#1450, epic #1448).
//
// The DB authority for the `artifact_publication_operations` table (DDL in the
// pure-strings leaf publication-operation-schema.ts, mirrored by migration
// core__0054). Draftable artifacts publish through a durable operation record;
// queue jobs are DELIVERY, not authority.
//
// Every transition is a SINGLE conditional SQL statement whose WHERE clause
// mirrors the corresponding guard in the PURE state machine
// (publication-operation-state.ts) — a zero-row update is exactly that module's
// `{ ok: false }` refusal, enforced by the DB atomically. The artifact's
// scheduled/published status is a projection written only via these transitions
// through the injected `PublicationStatusPort` (the #1449 trusted commands): the
// ledger row commits first and is the recoverable source of truth; the port is
// invoked exactly once per matched transition.
// ---------------------------------------------------------------------------

type QueryInput = { text: string; values?: unknown[] };
type QueryResult = { rows: Row[]; rowCount: number };

function pool(): Pool {
  return getPooledDb({
    name: "artifact-publication-ledger",
    connectionString: () => getPostgresConnectionString(),
  });
}

function q(): string {
  return postgresSchema.replaceAll('"', '""');
}

/**
 * Execute the ledger's statements through the async pooled DB. Per the #303
 * architecture track the sync bridge is the exceptional sync-leaf escape hatch,
 * NOT the request-time store path; this mirrors the sibling artifact ledger
 * materialization-ledger.ts (getPooledDb, same INSERT…ON CONFLICT DO NOTHING +
 * separate winner-read idiom).
 *
 * Returns the per-statement `{ rows, rowCount }` shape each transition reads.
 * Every non-transaction transition is a SINGLE conditional-CAS statement run
 * autocommit — its own fresh READ COMMITTED snapshot, the exact semantics the
 * schedule-dedupe "separate statement reads the winner under a fresh snapshot"
 * comment relies on. A `transaction` batch (only reconcile's two-statement
 * re-arm/fail sweep) checks a client out of the pool and brackets it in
 * BEGIN…COMMIT (ROLLBACK on throw) so both sweeps commit atomically —
 * preserving the sync bridge's `transaction: true` semantics exactly.
 */
async function run(queries: QueryInput[], transaction = false): Promise<QueryResult[]> {
  ensurePostgresSchema();
  if (!transaction) {
    const p = pool();
    const out: QueryResult[] = [];
    for (const query of queries) {
      const res = await p.query(query.text, query.values ? [...query.values] : undefined);
      out.push({ rows: res.rows as Row[], rowCount: res.rowCount ?? 0 });
    }
    return out;
  }
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out: QueryResult[] = [];
    for (const query of queries) {
      const res = await client.query(query.text, query.values ? [...query.values] : undefined);
      out.push({ rows: res.rows as Row[], rowCount: res.rowCount ?? 0 });
    }
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The full column projection, in a fixed order, for RETURNING / SELECT. */
const COLS = `id, org_id, artifact_id, object_type_id, pinned_representation_revision_id,
  destination_connector, destination_account, destination_ref, due_at, state, attempt,
  idempotency_key, cancellation_generation, receipt, error, created_by, created_at,
  updated_at, started_at, settled_at`;

type Row = Record<string, unknown>;

function mapRow(r: Row): PublicationOperationRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    artifactId: String(r.artifact_id),
    objectTypeId: String(r.object_type_id),
    pinnedRepresentationRevisionId: String(r.pinned_representation_revision_id),
    destination: {
      connector: String(r.destination_connector),
      account: r.destination_account == null ? null : String(r.destination_account),
      ref: r.destination_ref == null ? null : String(r.destination_ref),
    },
    dueAt: String(r.due_at),
    state: String(r.state) as PublicationOperationRow["state"],
    attempt: Number(r.attempt),
    idempotencyKey: String(r.idempotency_key),
    cancellationGeneration: Number(r.cancellation_generation),
    receipt: (r.receipt as PublicationReceipt | null) ?? null,
    error: r.error == null ? null : String(r.error),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: r.started_at == null ? null : String(r.started_at),
    settledAt: r.settled_at == null ? null : String(r.settled_at),
  };
}

function statusContext(row: PublicationOperationRow): PublicationStatusContext {
  return {
    orgId: row.orgId,
    artifactId: row.artifactId,
    operationId: row.id,
    pinnedRepresentationRevisionId: row.pinnedRepresentationRevisionId,
    actor: row.createdBy,
  };
}

// ---------------------------------------------------------------------------
// schedule (create) — pins a captured revision, locks the artifact
// ---------------------------------------------------------------------------

export type SchedulePublicationInput = {
  orgId: string;
  artifactId: string;
  objectTypeId: string;
  /** The exact captured representation revision to publish. MUST already exist
   * (representation capture must exist for a type before the ledger can pin it);
   * verified unless `skipRepresentationCheck` is set. */
  pinnedRepresentationRevisionId: string;
  destination: PublicationDestination;
  /** When the operation becomes due. Omit / null ⇒ "publish now" (immediately due). */
  dueAt?: Date | string | null;
  createdBy?: string | null;
  /** Escape hatch for tests / callers that pin a non-representation resource.
   * Production draftable publishing always leaves this false. */
  skipRepresentationCheck?: boolean;
};

export type SchedulePublicationResult = {
  operation: PublicationOperationRow;
  /** True when an existing live/succeeded operation for the same intent was
   * returned instead of inserting a duplicate (the double-publish backstop). */
  deduplicated: boolean;
};

/**
 * Schedule (or "publish now") a draftable artifact's captured revision to a
 * destination. Verifies the pinned revision exists and belongs to the artifact,
 * derives the stable idempotency key, and INSERTs a `pending` operation —
 * deduplicating against any existing live/succeeded operation for the same
 * intent (the partial-unique backstop). On a fresh insert the trusted `lock`
 * command marks the artifact `scheduled` (locked to edits).
 */
export async function schedulePublication(
  input: SchedulePublicationInput,
  port: PublicationStatusPort = NOOP_PUBLICATION_STATUS_PORT,
): Promise<SchedulePublicationResult> {
  if (!input.skipRepresentationCheck) {
    const rep = getRepresentationByIdForReplay(input.orgId, input.pinnedRepresentationRevisionId);
    if (!rep) {
      throw new Error(
        `cannot schedule publication: representation revision '${input.pinnedRepresentationRevisionId}' does not exist (representation capture must exist before the ledger can pin it)`,
      );
    }
    if (rep.artifactId !== input.artifactId) {
      throw new Error(
        `cannot schedule publication: representation revision '${input.pinnedRepresentationRevisionId}' belongs to artifact '${rep.artifactId}', not '${input.artifactId}'`,
      );
    }
  }

  const idempotencyKey = deriveIdempotencyKey({
    orgId: input.orgId,
    artifactId: input.artifactId,
    pinnedRepresentationRevisionId: input.pinnedRepresentationRevisionId,
    destination: input.destination,
  });
  const dueAt: string | null =
    input.dueAt == null
      ? null
      : input.dueAt instanceof Date
        ? input.dueAt.toISOString()
        : input.dueAt;

  // INSERT the pending operation, deduplicating against any existing
  // live/succeeded operation for the same intent (the partial-unique index).
  // A losing racer's `ON CONFLICT DO NOTHING` returns zero rows only AFTER the
  // winner commits, so a SEPARATE statement then reads the winner under a fresh
  // READ COMMITTED snapshot — a single `INSERT … RETURNING … UNION` cannot see a
  // row committed after its own statement snapshot was taken. The bounded loop
  // also absorbs the rare case where a concurrent cancel frees the slot between
  // the conflicting insert and the lookup (retry the insert).
  let operation: PublicationOperationRow | null = null;
  let inserted = false;
  for (let attempt = 0; attempt < 3 && operation == null; attempt++) {
    const insRes = await run([
      {
        text: `INSERT INTO "${q()}"."artifact_publication_operations"
            (id, org_id, artifact_id, object_type_id, pinned_representation_revision_id,
             destination_connector, destination_account, destination_ref, due_at, state,
             attempt, idempotency_key, cancellation_generation, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()),
             'pending', 0, $10, 0, $11)
          ON CONFLICT (org_id, idempotency_key) WHERE state <> 'cancelled' DO NOTHING
          RETURNING ${COLS}`,
        values: [
          randomUUID(),
          input.orgId,
          input.artifactId,
          input.objectTypeId,
          input.pinnedRepresentationRevisionId,
          input.destination.connector,
          input.destination.account ?? null,
          input.destination.ref ?? null,
          dueAt,
          idempotencyKey,
          input.createdBy ?? null,
        ],
      },
    ]);
    const insRow = insRes?.[0]?.rows?.[0] as Row | undefined;
    if (insRow) {
      operation = mapRow(insRow);
      inserted = true;
      break;
    }
    // Conflict: the winning schedule is committed. Read it under a fresh snapshot.
    const selRes = await run([
      {
        text: `SELECT ${COLS} FROM "${q()}"."artifact_publication_operations"
          WHERE org_id = $1 AND idempotency_key = $2 AND state <> 'cancelled' LIMIT 1`,
        values: [input.orgId, idempotencyKey],
      },
    ]);
    const selRow = selRes?.[0]?.rows?.[0] as Row | undefined;
    if (selRow) {
      operation = mapRow(selRow);
      inserted = false;
    }
    // else: the slot was freed by a concurrent cancel between the two reads — retry.
  }
  if (operation == null) {
    throw new Error(
      "schedulePublication: could not resolve a live operation after contention retries",
    );
  }
  if (inserted) {
    // Trusted command: lock the artifact (status → scheduled). Only on a fresh
    // schedule — a dedupe hit is already locked (pending/running) or published.
    await port.onScheduled(statusContext(operation));
  }
  return { operation, deduplicated: !inserted };
}

// ---------------------------------------------------------------------------
// claim (pending → running) — the delivery fence
// ---------------------------------------------------------------------------

/**
 * Claim a due operation for delivery. Wins ONLY if the row is still `pending`,
 * still at the expected cancellation generation, and due. A cancelled /
 * re-scheduled / not-yet-due operation returns `null` — a stale worker
 * publishes nothing (the schedule→cancel→edit fence). No status effect (the
 * artifact was locked at schedule).
 */
export async function claimDueOperation(input: {
  orgId: string;
  operationId: string;
  expectedGeneration: number;
}): Promise<PublicationOperationRow | null> {
  const res = await run([
    {
      text: `UPDATE "${q()}"."artifact_publication_operations"
        SET state = 'running', attempt = attempt + 1, started_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'pending'
          AND cancellation_generation = $3 AND due_at <= now()
        RETURNING ${COLS}`,
      values: [input.operationId, input.orgId, input.expectedGeneration],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  return raw ? mapRow(raw) : null;
}

// ---------------------------------------------------------------------------
// settle (running → succeeded | failed)
// ---------------------------------------------------------------------------

/**
 * Record a successful publish. Wins only on a `running` row at the expected
 * generation, so a fenced generation can never mark the artifact published.
 * On success the trusted `publish` command marks the artifact `published` and
 * records the receipt.
 */
export async function settlePublicationSucceeded(
  input: {
    orgId: string;
    operationId: string;
    expectedGeneration: number;
    receipt: PublicationReceipt;
  },
  port: PublicationStatusPort = NOOP_PUBLICATION_STATUS_PORT,
): Promise<PublicationOperationRow | null> {
  const res = await run([
    {
      text: `UPDATE "${q()}"."artifact_publication_operations"
        SET state = 'succeeded', receipt = $4::jsonb, error = NULL,
            settled_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'running'
          AND cancellation_generation = $3
        RETURNING ${COLS}`,
      values: [
        input.operationId,
        input.orgId,
        input.expectedGeneration,
        JSON.stringify(input.receipt ?? {}),
      ],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  if (!raw) return null;
  const operation = mapRow(raw);
  await port.onPublished(statusContext(operation), operation.receipt ?? {});
  return operation;
}

/**
 * Record a failed publish. Wins only on a `running` row at the expected
 * generation. NO status effect: the artifact stays LOCKED with the operation in
 * `failed` (issue #1450 AC) — recovery is an explicit `retry` or `cancel`.
 */
export async function settlePublicationFailed(input: {
  orgId: string;
  operationId: string;
  expectedGeneration: number;
  error: string;
}): Promise<PublicationOperationRow | null> {
  const res = await run([
    {
      text: `UPDATE "${q()}"."artifact_publication_operations"
        SET state = 'failed', error = $4, settled_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'running'
          AND cancellation_generation = $3
        RETURNING ${COLS}`,
      values: [input.operationId, input.orgId, input.expectedGeneration, input.error],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  return raw ? mapRow(raw) : null;
}

// ---------------------------------------------------------------------------
// cancel (pending | failed → cancelled) — unschedule / abandon
// ---------------------------------------------------------------------------

/**
 * Unschedule a pending operation or abandon a failed one. Bumps the
 * cancellation generation (fencing any in-flight claim), frees the idempotency
 * slot, and invokes the trusted `unlock` command so the artifact returns to
 * editable (edit-after-unschedule). Refuses a `running`/`succeeded`/`cancelled`
 * operation (returns `null`).
 */
export async function cancelPublication(
  input: { orgId: string; operationId: string },
  port: PublicationStatusPort = NOOP_PUBLICATION_STATUS_PORT,
): Promise<PublicationOperationRow | null> {
  const res = await run([
    {
      text: `UPDATE "${q()}"."artifact_publication_operations"
        SET state = 'cancelled', cancellation_generation = cancellation_generation + 1,
            settled_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state IN ('pending', 'failed')
        RETURNING ${COLS}`,
      values: [input.operationId, input.orgId],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  if (!raw) return null;
  const operation = mapRow(raw);
  await port.onUnscheduled(statusContext(operation));
  return operation;
}

// ---------------------------------------------------------------------------
// retry (failed → pending) — bounded re-arm, same intent
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_PUBLICATION_ATTEMPTS = 5;

/**
 * Re-arm a failed operation for another delivery attempt, bounded by
 * `maxAttempts`. Generation is UNCHANGED (same idempotency key ⇒ connector
 * dedupe, never a second external effect). The artifact stays locked (no status
 * effect). Returns `null` if the operation is not `failed` or attempts are
 * exhausted.
 */
export async function retryFailedPublication(input: {
  orgId: string;
  operationId: string;
  maxAttempts?: number;
}): Promise<PublicationOperationRow | null> {
  const max = input.maxAttempts ?? DEFAULT_MAX_PUBLICATION_ATTEMPTS;
  const res = await run([
    {
      text: `UPDATE "${q()}"."artifact_publication_operations"
        SET state = 'pending', started_at = NULL, settled_at = NULL, error = NULL,
            updated_at = now()
        WHERE id = $1 AND org_id = $2 AND state = 'failed' AND attempt < $3
        RETURNING ${COLS}`,
      values: [input.operationId, input.orgId, max],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  return raw ? mapRow(raw) : null;
}

// ---------------------------------------------------------------------------
// reconcile — sweep crashed (lease-timed-out) running operations
// ---------------------------------------------------------------------------

/**
 * Reconcile running operations whose delivery lease elapsed (worker presumed
 * crashed). Re-arms those with attempts remaining to `pending`; settles the rest
 * to `failed`. Never unlocks the artifact (a failed reconcile leaves it locked,
 * like any publish failure). Returns the counts. Generation is unchanged
 * throughout (same intent, same idempotency key).
 */
export async function reconcileStalePublications(input: {
  leaseMs: number;
  maxAttempts?: number;
  orgId?: string;
}): Promise<{ reArmed: number; failed: number }> {
  const max = input.maxAttempts ?? DEFAULT_MAX_PUBLICATION_ATTEMPTS;
  const orgClause = input.orgId ? `AND org_id = $3` : "";
  const orgValues = input.orgId ? [input.orgId] : [];
  const staleWhere = `state = 'running' AND started_at IS NOT NULL
    AND started_at <= now() - ($1::double precision * interval '1 millisecond') ${orgClause}`;
  const res = await run(
    [
      {
        // Re-arm the ones with attempts remaining.
        text: `UPDATE "${q()}"."artifact_publication_operations"
          SET state = 'pending', started_at = NULL, updated_at = now()
          WHERE ${staleWhere} AND attempt < $2
          RETURNING id`,
        values: [input.leaseMs, max, ...orgValues],
      },
      {
        // Fail the exhausted ones.
        text: `UPDATE "${q()}"."artifact_publication_operations"
          SET state = 'failed', error = 'reconcile: delivery lease timed out',
              settled_at = now(), updated_at = now()
          WHERE ${staleWhere} AND attempt >= $2
          RETURNING id`,
        values: [input.leaseMs, max, ...orgValues],
      },
    ],
    true,
  );
  return {
    reArmed: res?.[0]?.rowCount ?? 0,
    failed: res?.[1]?.rowCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** One operation by id, or null. */
export async function getPublicationOperation(
  orgId: string,
  operationId: string,
): Promise<PublicationOperationRow | null> {
  const res = await run([
    {
      text: `SELECT ${COLS} FROM "${q()}"."artifact_publication_operations"
        WHERE org_id = $1 AND id = $2 LIMIT 1`,
      values: [orgId, operationId],
    },
  ]);
  const raw = res?.[0]?.rows?.[0] as Row | undefined;
  return raw ? mapRow(raw) : null;
}

/** All operations for an artifact, newest first (the library per-artifact rollup). */
export async function listPublicationOperationsForArtifact(
  orgId: string,
  artifactId: string,
): Promise<PublicationOperationRow[]> {
  const res = await run([
    {
      text: `SELECT ${COLS} FROM "${q()}"."artifact_publication_operations"
        WHERE org_id = $1 AND artifact_id = $2 ORDER BY created_at DESC`,
      values: [orgId, artifactId],
    },
  ]);
  return ((res?.[0]?.rows ?? []) as Row[]).map(mapRow);
}

/** Due pending operations, oldest-due first — the delivery scanner's seam.
 * The caller claims each via `claimDueOperation(op.id, op.cancellationGeneration)`. */
export async function listDuePublicationOperations(input: {
  limit?: number;
  orgId?: string;
}): Promise<PublicationOperationRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const orgClause = input.orgId ? `AND org_id = $2` : "";
  const values: unknown[] = [limit];
  if (input.orgId) values.push(input.orgId);
  const res = await run([
    {
      text: `SELECT ${COLS} FROM "${q()}"."artifact_publication_operations"
        WHERE state = 'pending' AND due_at <= now() ${orgClause}
        ORDER BY due_at ASC LIMIT $1`,
      values,
    },
  ]);
  return ((res?.[0]?.rows ?? []) as Row[]).map(mapRow);
}
