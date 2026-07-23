/**
 * Namespaced org advisory locks — cinatra#1938 (archive epic S2).
 *
 * Keys live in PostgreSQL's TWO-ARGUMENT advisory-lock space
 * (`pg_advisory_xact_lock(int, int)` = (hashtext(namespace), hashtext(subkey))),
 * following the existing convention ('cinatra', 'cinatra-migrations',
 * 'cinatra-team-members' namespaces). That space is structurally disjoint from
 * the single-argument bigint space where every dashboards/artifact lock lives
 * (`pg_advisory_xact_lock(hashtext(id))`, e.g. mutation-service's dashboardId
 * lock) — non-collision with #1894's twin-writer locks holds by construction,
 * no coordination required.
 *
 * GLOBAL LOCK ORDER (deadlock freedom): the epoch lock is always acquired
 * BEFORE the write lock. `acquireOrgLocks` is the only acquisition path and
 * encodes the order; there is deliberately NO API to take the epoch lock after
 * the write lock (guardOrgMutation is write-only; epoch transitions and ticket
 * redemption use entry points that pass { epoch: true } up front).
 */
import { sql, type SQL } from "drizzle-orm";

/** Never used before this package (verified against the repo-wide lock-key
 *  landscape at design time); do not reuse elsewhere. */
export const ORG_WRITE_LOCK_NAMESPACE = "cinatra-org-write";
export const ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE = "cinatra-org-archive-epoch";

export interface OrgLockRequest {
  readonly orgId: string;
  /** Also take the archive-epoch lock (epoch transitions, ticket redemption). */
  readonly epoch: boolean;
}

/** Minimal drizzle-ish tx handle (assistant-namespace-lock precedent): anything
 *  exposing `.execute()`; the node-postgres drizzle tx satisfies this. */
export interface OrgWriteTx {
  execute(query: SQL | string): Promise<unknown>;
}

/** Minimal drizzle-ish db handle exposing `.transaction()`, generic so callers
 *  keep their full transaction type. */
export interface OrgWriteDb<TTx extends OrgWriteTx = OrgWriteTx> {
  transaction<R>(fn: (tx: TTx) => Promise<R>): Promise<R>;
}

/** The lock statements in canonical global order (epoch first when requested).
 *  Exposed as data so the batch adapter can splice the identical statements. */
export function orgLockStatements(req: OrgLockRequest): SQL[] {
  const statements: SQL[] = [];
  if (req.epoch) {
    statements.push(
      sql`SELECT pg_advisory_xact_lock(hashtext(${ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE}), hashtext(${req.orgId}))`,
    );
  }
  statements.push(
    sql`SELECT pg_advisory_xact_lock(hashtext(${ORG_WRITE_LOCK_NAMESPACE}), hashtext(${req.orgId}))`,
  );
  return statements;
}

/** Same statements as plain parameterized queries for the fixed-batch world. */
export function orgLockQueries(
  req: OrgLockRequest,
): { text: string; values: unknown[] }[] {
  const queries: { text: string; values: unknown[] }[] = [];
  if (req.epoch) {
    queries.push({
      text: "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      values: [ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE, req.orgId],
    });
  }
  queries.push({
    text: "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    values: [ORG_WRITE_LOCK_NAMESPACE, req.orgId],
  });
  return queries;
}

/** Acquire the org locks on an already-open transaction, in global order. */
export async function acquireOrgLocks(
  tx: OrgWriteTx,
  req: OrgLockRequest,
): Promise<void> {
  for (const statement of orgLockStatements(req)) {
    await tx.execute(statement);
  }
}
