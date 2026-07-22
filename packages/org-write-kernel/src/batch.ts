/**
 * Guarded fixed-query batches — cinatra#1938 (archive epic S2).
 *
 * The postgres-sync world runs FIXED {text, values} arrays (no callback, no
 * branching), so the refusal must live inside the SQL. The guard query is
 * generated from the same capability table + lease predicate the callback
 * adapter evaluates (single source — no drift between the write worlds), and
 * refuses by casting a descriptive message to int (the error text carries the
 * reason) whenever the allow-condition matches no row.
 *
 * The batch value is OPAQUE: a WeakSet-registered wrapper the host wrapper
 * must unwrap via `guardedBatchQueries` — which is the only accessor and lives
 * behind a wrapper that unconditionally runs the batch with
 * `transaction: true`. A hand-built array can't impersonate one.
 */
import {
  ORG_WRITE_CAPABILITY_TABLE,
  type OrgWriteCapability,
} from "./capabilities";
import { orgLockQueries } from "./locks";
import { assertSafeSchemaName } from "./org-state";
import type { OrgWriteAuthority } from "./guard";
import { OrgWriteRefusedError } from "./guard";

export interface QueryInput {
  readonly text: string;
  readonly values?: unknown[];
}

declare const GUARDED_BATCH_BRAND: unique symbol;
export interface GuardedOrgWriteBatch {
  readonly [GUARDED_BATCH_BRAND]: true;
}

const GUARDED = new WeakSet<object>();
const QUERIES = new WeakMap<object, QueryInput[]>();

export interface GuardedBatchRequest {
  readonly orgId: string;
  readonly capability: OrgWriteCapability;
  readonly authority: OrgWriteAuthority;
  /** Required when the archived-state ruling for `capability` is lease-gated. */
  readonly schema?: string;
}

/** Refuse-by-cast: `('message')::int` fails with the message in the error. */
function refusalExpression(message: string): string {
  const safe = message.replace(/'/g, "''");
  return `('org-write-kernel refused: ${safe}')::int`;
}

/**
 * Build the in-SQL guard for this capability from the capability table. The
 * allow-condition is generated per the table's two state rulings; lease-gated
 * archived rulings embed the lease EXISTS with the same columns as
 * `leaseHeldQuery` (values appended by the caller).
 */
export function guardQueryFor(
  request: GuardedBatchRequest,
): QueryInput {
  const { orgId, capability, authority } = request;
  const activeRuling = ORG_WRITE_CAPABILITY_TABLE.active[capability];
  const archivedRuling = ORG_WRITE_CAPABILITY_TABLE.archived[capability];

  const activeCondition =
    activeRuling === "allow" ? `o."archivedAt" IS NULL` : `false`;

  let archivedCondition: string;
  const values: unknown[] = [orgId];
  if (archivedRuling === "allow") {
    archivedCondition = `o."archivedAt" IS NOT NULL`;
  } else if (archivedRuling === "deny") {
    archivedCondition = `false`;
  } else {
    // lease-gated: identical column set + expiry condition as leaseHeldQuery.
    if (
      request.schema === undefined ||
      authority.runId === undefined ||
      authority.executionAttemptId === undefined
    ) {
      throw new OrgWriteRefusedError(
        "lease-required-but-not-held",
        "lease-gated ruling without schema/run identity (batch build)",
      );
    }
    assertSafeSchemaName(request.schema);
    // Same column set + expiry condition as leaseHeldQuery/leaseHeldStatement,
    // with the epoch read live from the locked org row in the same statement.
    archivedCondition =
      `o."archivedAt" IS NOT NULL AND EXISTS (` +
      `SELECT 1 FROM "${request.schema}"."org_archive_lease" l` +
      ` WHERE l.org_id = o.id AND l.archive_epoch = COALESCE(o."archiveEpoch", 0)` +
      ` AND l.run_id = $2 AND l.execution_attempt_id = $3 AND l.expires_at > now())`;
    values.push(authority.runId, authority.executionAttemptId);
  }

  return {
    text:
      `SELECT COALESCE(` +
      `(SELECT 1 FROM public."organization" o WHERE o.id = $1 AND ((${activeCondition}) OR (${archivedCondition}))), ` +
      `${refusalExpression(`${capability} not permitted for this organization's lifecycle state`)})`,
    values,
  };
}

export function buildGuardedOrgWriteBatch(
  request: GuardedBatchRequest,
  queries: readonly QueryInput[],
): GuardedOrgWriteBatch {
  const { orgId, capability, authority } = request;
  if (authority.orgId !== orgId) {
    throw new OrgWriteRefusedError("authority-org-mismatch");
  }
  if (!authority.can(capability)) {
    throw new OrgWriteRefusedError("authority-lacks-capability", capability);
  }
  const assembled: QueryInput[] = [
    ...orgLockQueries({ orgId, epoch: false }),
    guardQueryFor(request),
    ...queries,
  ];
  const batch = Object.freeze({}) as GuardedOrgWriteBatch;
  GUARDED.add(batch);
  QUERIES.set(batch, assembled);
  return batch;
}

/** The ONLY unwrap. The host wrapper (src/lib/org-write) calls this and runs
 *  the result with `transaction: true` unconditionally. */
export function guardedBatchQueries(batch: GuardedOrgWriteBatch): QueryInput[] {
  if (!GUARDED.has(batch)) {
    throw new OrgWriteRefusedError("not-a-guarded-batch");
  }
  return [...(QUERIES.get(batch) ?? [])];
}
