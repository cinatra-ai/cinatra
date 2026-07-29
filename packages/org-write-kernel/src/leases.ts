/**
 * Archive-epoch lease rows — cinatra#1938 (archive epic S2).
 *
 * A lease is the bounded, verifiable window an in-flight run gets when its
 * organization archives: {org_id, archive_epoch, run_id, execution_attempt_id,
 * acquired_at, expires_at}, expiry copied from the run's OWN
 * execution_deadline_at (the S1 lease-math anchor). Table DDL lives host-side
 * with the other app-schema DDL; the kernel owns the SQL shapes so eligibility
 * can never drift from `isLiveAttempt` (single predicate source).
 */
import { sql, type SQL } from "drizzle-orm";
import { assertSafeSchemaName } from "./org-state";
import { liveAttemptSqlCondition } from "./live-attempt";

export const ORG_ARCHIVE_LEASE_TABLE = "org_archive_lease";

export interface LeaseKey {
  readonly schema: string;
  readonly orgId: string;
  readonly archiveEpoch: number;
  readonly runId: string;
  readonly executionAttemptId: string;
}

/** EXISTS-check for an unexpired lease — the fail-closed "lease-gated" gate.
 *  Returned as {text, values} so both adapters splice the identical predicate. */
export function leaseHeldQuery(key: LeaseKey): { text: string; values: unknown[] } {
  assertSafeSchemaName(key.schema);
  return {
    text:
      `SELECT 1 FROM "${key.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3` +
      ` AND execution_attempt_id = $4 AND expires_at > now()`,
    values: [key.orgId, key.archiveEpoch, key.runId, key.executionAttemptId],
  };
}

/** The SAME check as a drizzle statement for the callback adapter — kept in
 *  this file beside the {text, values} twin so the two write worlds share one
 *  source of lease semantics. */
export function leaseHeldStatement(key: LeaseKey): SQL {
  assertSafeSchemaName(key.schema);
  return sql`SELECT 1 FROM ${sql.raw(`"${key.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"`)} WHERE org_id = ${key.orgId} AND archive_epoch = ${key.archiveEpoch} AND run_id = ${key.runId} AND execution_attempt_id = ${key.executionAttemptId} AND expires_at > now()`;
}

/**
 * The archive-time snapshot (what the S6 archive transaction executes while
 * holding BOTH org locks): one INSERT..SELECT minting a lease for every run
 * that passes the shared live-attempt predicate at that instant. Expiry is the
 * run's own execution deadline; runs the predicate rejects (pre-dispatch,
 * reset-to-input, expired) get NO window — fail-closed.
 */
export function snapshotLeasesQuery(input: {
  schema: string;
  orgId: string;
  archiveEpoch: number;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `INSERT INTO "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` (org_id, archive_epoch, run_id, execution_attempt_id, acquired_at, expires_at)` +
      ` SELECT r.org_id, $2::int, r.id, r.execution_attempt_id, now(), r.execution_deadline_at` +
      ` FROM "${input.schema}".agent_runs r` +
      ` WHERE r.org_id = $1 AND ${liveAttemptSqlCondition("r")}` +
      ` ON CONFLICT (org_id, archive_epoch, run_id) DO NOTHING`,
    values: [input.orgId, input.archiveEpoch],
  };
}

/** Invalidation on unarchive / re-archive: every lease of a superseded epoch
 *  dies with the epoch (the transition transaction runs this before commit). */
export function invalidateLeasesBeforeEpochQuery(input: {
  schema: string;
  orgId: string;
  newEpoch: number;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `DELETE FROM "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` WHERE org_id = $1 AND archive_epoch < $2`,
    values: [input.orgId, input.newEpoch],
  };
}

/**
 * Per-run lease SETTLEMENT — cinatra#1940 P1 (Decision 4). Deletes EVERY lease
 * row a run holds, keyed by (org_id, run_id) and deliberately EPOCH-AGNOSTIC: a
 * run landing terminally settles all its windows across epochs in one shot, so
 * a stale-epoch leftover dies with the run. (The epoch-invalidation sweep,
 * `invalidateLeasesBeforeEpochQuery`, stays the bulk cleaner; this is the
 * precise per-run one, folded into the terminal transaction so status + lease
 * settlement commit atomically.) The DELETE rides the PK-prefixed
 * `(org_id, …, run_id)` index of a table that is EMPTY except under archive —
 * measurable-zero on the hot path for active orgs.
 *
 * As a drizzle statement for the callback adapter (the terminal-tx fold), kept
 * beside its `{text, values}` twin so both write worlds share one settle shape.
 */
export function settleLeaseForRunStatement(input: {
  schema: string;
  orgId: string;
  runId: string;
}): SQL {
  assertSafeSchemaName(input.schema);
  return sql`DELETE FROM ${sql.raw(`"${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"`)} WHERE org_id = ${input.orgId} AND run_id = ${input.runId}`;
}

/** The SAME per-run settle as a `{text, values}` pair for the fixed-batch world
 *  (positional params), twin of `settleLeaseForRunStatement`. */
export function settleLeaseForRunQuery(input: {
  schema: string;
  orgId: string;
  runId: string;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `DELETE FROM "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` WHERE org_id = $1 AND run_id = $2`,
    values: [input.orgId, input.runId],
  };
}

// ---------------------------------------------------------------------------
// Lease-expiry finalizer shapes — cinatra#1940 P4. Pure SQL
// builders, same discipline as the shapes above: the kernel owns every shape
// that touches `org_archive_lease` so eligibility/durability semantics have
// one source. None of these run inside `guardOrgMutation`/
// `guardOrgLifecycleMutation` EXCEPT `expiredLeaseForUpdateStatement` (used
// inside the fence by `finalizeExpiredLeaseRun`); the sweep read and the
// attempts/escalation writes are POOLED (phase 1, durable runtime-cancel
// bookkeeping) — deliberately outside any org lock, per the design's phased
// split (phase 1 durability, phase 2 the audited fenced settle).
// ---------------------------------------------------------------------------

/** Bounded batch sweep read (pooled, no authority — advisory only; the fence
 *  + FOR UPDATE re-verify inside `finalizeExpiredLeaseRun` are the actual
 *  admission check). Oldest-expiry first so a backlog drains FIFO.
 *
 *  LEFT JOIN (not INNER) on `agent_runs`: `finalizeExpiredLeaseRun` treats a
 *  vanished run row as settle-orphan (lease-only DELETE, the same path an
 *  already-terminal run takes) — an INNER JOIN would make that path
 *  unreachable from the sweep, leaving orphaned lease rows (whose run was
 *  deleted out from under them) stranded forever. `r.status`, `r.a2a_task_id`,
 *  `r.template_id` are NULL for an orphan row; the caller must treat all
 *  three as optional. */
export function sweepExpiredLeasesQuery(input: {
  schema: string;
  limit: number;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `SELECT l.org_id, l.archive_epoch, l.run_id, l.execution_attempt_id, l.finalize_attempts,` +
      ` r.status, r.a2a_task_id, r.template_id` +
      ` FROM "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}" l` +
      ` LEFT JOIN "${input.schema}".agent_runs r ON r.id = l.run_id` +
      ` WHERE l.expires_at <= now()` +
      ` ORDER BY l.expires_at ASC` +
      ` LIMIT $1`,
    values: [input.limit],
  };
}

/** Atomic conditional attempts-increment: a single statement increments AND
 *  re-verifies the lease is still expired in one round trip. 0 rows returned
 *  means the lease was
 *  settled/epoch-invalidated/not-actually-expired since the sweep read — the
 *  caller MUST skip, never mutate a lease this returns nothing for. */
export function incrementLeaseFinalizeAttemptsQuery(input: {
  schema: string;
  orgId: string;
  archiveEpoch: number;
  runId: string;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `UPDATE "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` SET finalize_attempts = finalize_attempts + 1, finalize_last_attempt_at = now()` +
      ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND expires_at <= now()` +
      ` RETURNING finalize_attempts`,
    values: [input.orgId, input.archiveEpoch, input.runId],
  };
}

/** Idempotent escalation stamp: 0 rows means already escalated (a concurrent
 *  tick beat this one) — the caller proceeds to force-settle WITHOUT a
 *  second escalation audit. */
export function escalateLeaseFinalizeQuery(input: {
  schema: string;
  orgId: string;
  archiveEpoch: number;
  runId: string;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `UPDATE "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` SET finalize_escalated_at = now()` +
      ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND finalize_escalated_at IS NULL` +
      ` RETURNING finalize_escalated_at`,
    values: [input.orgId, input.archiveEpoch, input.runId],
  };
}

/** Pre-cancel re-verify (phase 1): a cheap, pooled, read-only EXISTS check —
 *  is this lease STILL expired at THIS moment, at the SAME (org, epoch, run)
 *  the sweep read? Called immediately before `bestEffortCancelRuntime`
 *  (lease-expiry-finalizer.ts) to narrow the window between the
 *  attempts-increment (which can succeed just before an unarchive invalidates
 *  the lease) and the runtime-cancel side-effect: cancelling a runtime for a
 *  run the fence would now refuse to finalize is a real user-visible harm
 *  (interrupting a run that is legitimately continuing post-unarchive), unlike
 *  a redundant/no-op settle attempt. This is advisory only, same as
 *  `sweepExpiredLeasesQuery` — the fence's own FOR UPDATE re-verify inside
 *  `finalizeExpiredLeaseRun` remains the actual admission check for the
 *  WRITE; this shape only gates the best-effort cancel side-effect. */
export function leaseStillExpiredQuery(input: {
  schema: string;
  orgId: string;
  archiveEpoch: number;
  runId: string;
}): { text: string; values: unknown[] } {
  assertSafeSchemaName(input.schema);
  return {
    text:
      `SELECT 1 FROM "${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"` +
      ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND expires_at <= now()`,
    values: [input.orgId, input.archiveEpoch, input.runId],
  };
}

/** In-fence re-verify (phase 2): locks the exact expired-lease row FOR UPDATE
 *  inside `finalizeExpiredLeaseRun`'s guarded transaction, BEFORE any
 *  terminal write. `archiveEpoch` MUST be the fence's own locked-state epoch
 *  (the permit's `archiveEpoch`) — never the sweep's stale read — so an
 *  unarchive that lands between the sweep and the fence self-resolves (the
 *  re-verify finds no row at the new epoch). As a drizzle SQL statement (the
 *  callback-world fence tx). */
export function expiredLeaseForUpdateStatement(input: {
  schema: string;
  orgId: string;
  archiveEpoch: number;
  runId: string;
}): SQL {
  assertSafeSchemaName(input.schema);
  return sql`SELECT run_id, execution_attempt_id FROM ${sql.raw(`"${input.schema}"."${ORG_ARCHIVE_LEASE_TABLE}"`)} WHERE org_id = ${input.orgId} AND archive_epoch = ${input.archiveEpoch} AND run_id = ${input.runId} AND expires_at <= now() FOR UPDATE`;
}
