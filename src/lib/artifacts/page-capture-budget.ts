import "server-only";

// ---------------------------------------------------------------------------
// THE PAGE CAPTURE BUDGET (cinatra#4223): at most MAX_PAGE_CAPTURES_PER_RUN
// captures per run, at most MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN at once.
//
// A budget held in one server process is no limit: calls routed to other
// processes, a restart or an evicted entry start from zero. So every process
// reads one table (page-capture-lease-schema.ts), and the check and the take
// are ONE transaction that first takes `pg_advisory_xact_lock` on the run's key,
// so two racing callers of one run are serialized.
//
// FAIL CLOSED: a store that cannot be read or written refuses the capture
// (`budget_unavailable`). A lease never released (a crash) stays in flight until
// its TTL ends and always counts toward the run's total. Times are the
// database clock read by `clock_timestamp()` when each statement runs, NOT
// `now()`: `now()` is the start of the transaction, so a call that waited on the
// lock would stamp its lease with a moment before the wait and its lease could
// already be expired when it commits. The caller passes the organisation and
// run the server resolved, never ids from the call's input.
// ---------------------------------------------------------------------------

import { getPooledDb } from "@/lib/db/pooled";
import { postgresSchema } from "@/lib/postgres-config";
import { logFailure } from "@/lib/failure-log";
import { PAGE_CAPTURE_LEASES_TABLE } from "./page-capture-lease-schema";

/** At most this many page captures per run. */
export const MAX_PAGE_CAPTURES_PER_RUN = 20;
/** At most this many page captures of one run at once. */
export const MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN = 2;
/** A lease that was not released stops counting as in flight after this many seconds. */
export const PAGE_CAPTURE_LEASE_TTL_SECONDS = 300;

export type PageCaptureBudgetRefusal =
  /** The run already took MAX_PAGE_CAPTURES_PER_RUN leases. */
  | "run_cap_exceeded"
  /** The run already holds MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN live leases. */
  | "concurrency_exceeded"
  /** The budget store could not be read or written. */
  | "budget_unavailable";

export type PageCaptureLease = {
  leaseId: string;
  /** Ends the capture's lease. Never throws; a second call does nothing. */
  release: () => Promise<void>;
};

export type PageCaptureBudgetAnswer =
  | { ok: true; lease: PageCaptureLease }
  | { ok: false; reason: PageCaptureBudgetRefusal };

export type PageCaptureBudgetQuery = <T = unknown>(text: string, values?: readonly unknown[]) => Promise<T[]>;

/** Runs `fn` inside ONE transaction (BEGIN, then COMMIT, or ROLLBACK on a throw). */
export type PageCaptureBudgetTransaction = <T>(
  fn: (txQuery: PageCaptureBudgetQuery) => Promise<T>,
) => Promise<T>;

export type PageCaptureBudgetLimits = { perRun: number; concurrent: number; ttlSeconds: number };

export type PageCaptureBudgetDeps = {
  transaction?: PageCaptureBudgetTransaction;
  query?: PageCaptureBudgetQuery;
  /** The unescaped schema name; the configured one when omitted. */
  schema?: string;
  limits?: PageCaptureBudgetLimits;
};

const DEFAULT_LIMITS: PageCaptureBudgetLimits = {
  perRun: MAX_PAGE_CAPTURES_PER_RUN,
  concurrent: MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN,
  ttlSeconds: PAGE_CAPTURE_LEASE_TTL_SECONDS,
};

const POOL_NAME = "page-capture-budget";

const defaultQuery: PageCaptureBudgetQuery = async <T = unknown>(text: string, values?: readonly unknown[]) =>
  (await getPooledDb({ name: POOL_NAME }).query(text, values ? [...values] : undefined)).rows as T[];

const defaultTransaction: PageCaptureBudgetTransaction = async (fn) => {
  const client = await getPooledDb({ name: POOL_NAME }).connect();
  try {
    await client.query("BEGIN");
    const out = await fn(async <U = unknown>(text: string, values?: readonly unknown[]) =>
      (await client.query(text, values ? [...values] : undefined)).rows as U[],
    );
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); // the original error decides the answer
    throw err;
  } finally {
    client.release();
  }
};

function table(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."${PAGE_CAPTURE_LEASES_TABLE}"`;
}

/** The advisory-lock key of one run's budget: a JSON array, so no two pairs of ids share a key text. */
export function pageCaptureBudgetLockKey(orgId: string, runId: string): string {
  return JSON.stringify([PAGE_CAPTURE_LEASES_TABLE, orgId, runId]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Take one capture of the run's budget, or name the limit that refuses it.
 * Never throws: a store failure is the refusal `budget_unavailable`.
 */
export async function acquirePageCaptureLease(
  input: { orgId: string; runId: string },
  deps: PageCaptureBudgetDeps = {},
): Promise<PageCaptureBudgetAnswer> {
  const { orgId, runId } = input;
  if (!isId(orgId) || !isId(runId)) return { ok: false, reason: "budget_unavailable" };
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const t = table(deps.schema ?? postgresSchema);
  const transaction = deps.transaction ?? defaultTransaction;
  try {
    const taken = await transaction(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        pageCaptureBudgetLockKey(orgId, runId),
      ]);
      const [counts] = await q<{ total: number; live: number }>(
        `SELECT count(*)::int AS total,
       (count(*) FILTER (WHERE released_at IS NULL AND expires_at > clock_timestamp()))::int AS live
  FROM ${t} WHERE org_id = $1 AND run_id = $2`,
        [orgId, runId],
      );
      const total = counts?.total;
      const live = counts?.live;
      if (!Number.isInteger(total) || !Number.isInteger(live)) {
        return { ok: false as const, reason: "budget_unavailable" as const };
      }
      if ((total as number) >= limits.perRun) {
        return { ok: false as const, reason: "run_cap_exceeded" as const };
      }
      if ((live as number) >= limits.concurrent) {
        return { ok: false as const, reason: "concurrency_exceeded" as const };
      }
      const [row] = await q<{ id: string }>(
        `INSERT INTO ${t} (id, org_id, run_id, acquired_at, expires_at)
SELECT gen_random_uuid()::text, $1::text, $2::text, stamp.taken_at, stamp.taken_at + make_interval(secs => $3::double precision)
  FROM (SELECT clock_timestamp() AS taken_at) AS stamp
RETURNING id`,
        [orgId, runId, limits.ttlSeconds],
      );
      const leaseId = row?.id;
      // The insert ran. An answer without a usable id must not commit that row as a lease nobody holds: throw, so the
      // transaction rolls back, and the catch below answers budget_unavailable.
      if (!isId(leaseId)) throw new Error("page capture budget: the lease insert returned no id");
      return { ok: true as const, leaseId };
    });
    if (!taken.ok) return taken;
    return { ok: true, lease: leaseHandle(taken.leaseId, orgId, runId, t, deps) };
  } catch (err) {
    logFailure("page capture budget: the lease store failed; the capture is refused", { orgId, runId }, err);
    return { ok: false, reason: "budget_unavailable" };
  }
}

function leaseHandle(
  leaseId: string,
  orgId: string,
  runId: string,
  t: string,
  deps: PageCaptureBudgetDeps,
): PageCaptureLease {
  let released = false;
  return {
    leaseId,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await (deps.query ?? defaultQuery)(
          `UPDATE ${t} SET released_at = clock_timestamp()
  WHERE id = $1 AND org_id = $2 AND run_id = $3 AND released_at IS NULL`,
          [leaseId, orgId, runId],
        );
      } catch (err) {
        // The lease stays in flight until its TTL ends: the budget errs on the side of fewer captures.
        logFailure("page capture budget: a lease release failed; it ends at its TTL", { orgId, runId, leaseId }, err);
      }
    },
  };
}
