import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { projectDispatchAttempts, projectLeases } from "./schema";

// ---------------------------------------------------------------------------
// project-dispatch-ledger-store (cinatra#1032 deliverable 2)
// ---------------------------------------------------------------------------
// Pure DB layer for `project_dispatch_attempts` — the dispatch-attempt LEDGER
// the dynamic-dispatch primitive writes AHEAD of `createAgentRun`, keyed
// UNIQUE (org_id, item_natural_key, action_version).
//
//   - beginDispatchAttempt: the LEASE-FENCED write-ahead claim. One SQL
//     statement (INSERT … SELECT FROM project_leases WHERE the caller is the
//     live holder at the presented fencing version … ON CONFLICT DO NOTHING),
//     so there is NO read-then-write window in which a stale holder — one
//     whose lease expired and was stolen between a lease read and the claim —
//     can open a fresh attempt. Three distinguishable outcomes:
//       'inserted'       — fresh claim, lease held (proceed to dispatch);
//       'existing'       — the (item, action_version) attempt already exists
//                          (recovery/idempotent path; caller MUST verify the
//                          immutable binding fields match before proceeding);
//       'lease_not_held' — the caller is not the live lease holder (stop).
//   - settleDispatchAttempt: optimistic-CAS settle (WHERE id + version) with
//     read-back. A CAS miss that lands on an IDENTICAL settled result is
//     accepted (an at-least-once recovery tick settling the same outcome); a
//     different result is a conflict.
//   - readDispatchAttempt: by ledger key.
//
// The idempotency_key column carries the deterministically derived key passed
// VERBATIM to `createAgentRun` (derive it with deriveDispatchIdempotencyKey),
// so a tick crashing anywhere between the claim and the settle re-converges
// onto the SAME child run on the next pass. Server-only.
// ---------------------------------------------------------------------------

export type DispatchAttemptStatus = "pending" | "dispatched" | "failed";

export type DispatchAttemptRecord = {
  id: string;
  orgId: string;
  projectRef: string;
  itemNaturalKey: string;
  actionVersion: number;
  workerRole: string;
  workerPackage: string;
  /** Canonical `kind:value` fingerprint of the binding's version constraint —
   *  part of the immutable attempt identity (drift under the same
   *  actionVersion is refused by the primitive). */
  workerVersionConstraint: string;
  /** Passed VERBATIM to createAgentRun. */
  idempotencyKey: string;
  runId: string | null;
  status: DispatchAttemptStatus;
  error: string | null;
  /** Optimistic-CAS counter. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type BeginDispatchAttemptResult =
  | { kind: "inserted"; attempt: DispatchAttemptRecord }
  | { kind: "existing"; attempt: DispatchAttemptRecord }
  | { kind: "lease_not_held" };

function deserialize(row: typeof projectDispatchAttempts.$inferSelect): DispatchAttemptRecord {
  return {
    id:             row.id,
    orgId:          row.orgId,
    projectRef:     row.projectRef,
    itemNaturalKey: row.itemNaturalKey,
    actionVersion:  row.actionVersion,
    workerRole:     row.workerRole,
    workerPackage:  row.workerPackage,
    workerVersionConstraint: row.workerVersionConstraint,
    idempotencyKey: row.idempotencyKey,
    runId:          row.runId,
    status:         row.status as DispatchAttemptStatus,
    error:          row.error,
    version:        row.version,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

/**
 * Derive THE idempotency key for a dispatch attempt. Deterministic and
 * collision-free across orgs/items/attempts (the natural key is immutable and
 * anchor-independent; `agent_runs_idempotency_key_uniq` is global, so the org
 * id must be part of the key). Passed VERBATIM to `createAgentRun`.
 */
export function deriveDispatchIdempotencyKey(
  orgId: string,
  itemNaturalKey: string,
  actionVersion: number,
): string {
  return `project:${orgId}:${itemNaturalKey}:${actionVersion}`;
}

/**
 * The lease-fenced write-ahead ledger claim (see the module header). The
 * INSERT only fires while the caller is the LIVE lease holder at the presented
 * fencing version — evaluated in the SAME statement, closing the TOCTOU window
 * between a lease read and the claim. `FOR UPDATE` on the lease row makes the
 * fence SERIALIZE against a concurrent steal: a claim racing an in-flight
 * `acquireProjectLease` upsert blocks on the row lock and re-evaluates the
 * predicate against the POST-steal row (READ COMMITTED lock-recheck), so a
 * stale holder's claim can never commit fenced against an already-stolen
 * lease. `ON CONFLICT DO NOTHING` makes a re-run of the same
 * (item, action_version) converge on the existing row.
 */
export async function beginDispatchAttempt(input: {
  orgId: string;
  projectRef: string;
  itemNaturalKey: string;
  actionVersion: number;
  workerRole: string;
  workerPackage: string;
  workerVersionConstraint: string;
  lease: { holderId: string; version: number };
}): Promise<BeginDispatchAttemptResult> {
  const id = `pda_${randomUUID()}`;
  const idempotencyKey = deriveDispatchIdempotencyKey(
    input.orgId,
    input.itemNaturalKey,
    input.actionVersion,
  );
  const res = await db.execute(sql`
    WITH live_lease AS (
      SELECT 1
        FROM ${projectLeases} l
       WHERE l.org_id = ${input.orgId}
         AND l.project_ref = ${input.projectRef}
         AND l.holder_id = ${input.lease.holderId}
         AND l.version = ${input.lease.version}
         AND l.expires_at > now()
         FOR UPDATE
    )
    INSERT INTO ${projectDispatchAttempts}
      (id, org_id, project_ref, item_natural_key, action_version,
       worker_role, worker_package, worker_version_constraint, idempotency_key, status)
    SELECT ${id}, ${input.orgId}, ${input.projectRef}, ${input.itemNaturalKey},
           ${input.actionVersion}, ${input.workerRole}, ${input.workerPackage},
           ${input.workerVersionConstraint}, ${idempotencyKey}, 'pending'
      FROM live_lease
    ON CONFLICT (org_id, item_natural_key, action_version) DO NOTHING
    RETURNING id
  `);
  const insertedId = (res.rows as Array<{ id: string }>)[0]?.id;
  if (insertedId) {
    const attempt = await readDispatchAttempt(
      input.orgId,
      input.itemNaturalKey,
      input.actionVersion,
    );
    if (!attempt) throw new Error(`beginDispatchAttempt: inserted row ${insertedId} vanished`);
    return { kind: "inserted", attempt };
  }
  // No row returned: either the ledger key already exists (conflict) or the
  // lease fence rejected the claim. Disambiguate — attempt row first: a
  // pre-existing attempt is meaningful recovery state regardless, but we only
  // report it as 'existing' while the caller still holds the lease (the fence
  // is the invariant being proven; the residual race — lease lost between the
  // claim and this read — errs to the conservative 'lease_not_held').
  const existing = await readDispatchAttempt(
    input.orgId,
    input.itemNaturalKey,
    input.actionVersion,
  );
  const [lease] = await db
    .select()
    .from(projectLeases)
    .where(
      and(
        eq(projectLeases.orgId, input.orgId),
        eq(projectLeases.projectRef, input.projectRef),
        eq(projectLeases.holderId, input.lease.holderId),
        eq(projectLeases.version, input.lease.version),
        sql`${projectLeases.expiresAt} > now()`,
      ),
    );
  if (!lease) return { kind: "lease_not_held" };
  if (!existing) {
    // Lease verified live but neither insert nor existing row: the only
    // remaining explanation is a concurrent DELETE of the attempt row (not an
    // operation this store exposes). Surface loudly rather than dispatch blind.
    throw new Error(
      `beginDispatchAttempt: claim for (${input.orgId}, ${input.itemNaturalKey}, ${input.actionVersion}) neither inserted nor found`,
    );
  }
  return { kind: "existing", attempt: existing };
}

export async function readDispatchAttempt(
  orgId: string,
  itemNaturalKey: string,
  actionVersion: number,
): Promise<DispatchAttemptRecord | null> {
  const [row] = await db
    .select()
    .from(projectDispatchAttempts)
    .where(
      and(
        eq(projectDispatchAttempts.orgId, orgId),
        eq(projectDispatchAttempts.itemNaturalKey, itemNaturalKey),
        eq(projectDispatchAttempts.actionVersion, actionVersion),
      ),
    );
  return row ? deserialize(row) : null;
}

export type SettleDispatchAttemptResult =
  | { kind: "settled"; attempt: DispatchAttemptRecord }
  | { kind: "conflict"; attempt: DispatchAttemptRecord | null };

/**
 * Optimistic-CAS settle: move the attempt to 'dispatched' (with its run id) or
 * 'failed' (with the error), guarded by (id, expectedVersion), bumping the CAS
 * counter. On a CAS miss the row is re-read: an IDENTICAL settled result
 * (same status + runId + error) is accepted idempotently — an at-least-once
 * recovery tick settling the same outcome — while a different result is a
 * conflict the caller must surface, never overwrite.
 */
export async function settleDispatchAttempt(input: {
  id: string;
  expectedVersion: number;
  status: Extract<DispatchAttemptStatus, "dispatched" | "failed">;
  runId?: string | null;
  error?: string | null;
}): Promise<SettleDispatchAttemptResult> {
  const [row] = await db
    .update(projectDispatchAttempts)
    .set({
      status:    input.status,
      runId:     input.runId ?? null,
      error:     input.error ?? null,
      version:   sql`${projectDispatchAttempts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectDispatchAttempts.id, input.id),
        eq(projectDispatchAttempts.version, input.expectedVersion),
      ),
    )
    .returning();
  if (row) return { kind: "settled", attempt: deserialize(row) };

  // CAS miss — read back and classify.
  const [current] = await db
    .select()
    .from(projectDispatchAttempts)
    .where(eq(projectDispatchAttempts.id, input.id));
  if (!current) return { kind: "conflict", attempt: null };
  const attempt = deserialize(current);
  if (
    attempt.status === input.status &&
    attempt.runId === (input.runId ?? null) &&
    attempt.error === (input.error ?? null)
  ) {
    return { kind: "settled", attempt };
  }
  return { kind: "conflict", attempt };
}
