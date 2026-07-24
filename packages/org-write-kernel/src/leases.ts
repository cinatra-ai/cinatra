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
