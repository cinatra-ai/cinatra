import "server-only";
import { Pool, type PoolClient } from "pg";
import { readRunTriggerByRunId, type TriggerRecord } from "./trigger-store";

// ---------------------------------------------------------------------------
// THE TRIGGER CLAIM — one serialization shared by stop, save and the tick
// (cinatra#2981)
// ---------------------------------------------------------------------------
//
// Three race windows in the trigger machinery were all the same shape: a writer
// READS the trigger row, DECIDES, and only later COMMITS, while **Cancel
// schedule** lands in between. A read cannot reserve anything, so each of them
// closed its own window with one more read and left a smaller one behind — the
// release job's own comment said so ("Closing that needs a row lock or a
// conditional write"). This module is that lock, and the point is that there is
// exactly ONE of it: the stop, the save, the release job's fire decisions and
// the PM handler's local writes all take it, so a decision one of them makes is
// never invalidated by another while it acts.
//
// WHAT IT IS. A transaction-scoped Postgres advisory lock keyed by the run id,
// in the same `pg_advisory_xact_lock(hashtext(namespace), hashtext(subkey))`
// shape the org-write kernel and the dashboards mutation service already use.
// Transaction-scoped, so it is released by COMMIT, by ROLLBACK, and by a
// dropped connection alike — a crashed holder can never strand a schedule.
//
// WHY AN ADVISORY LOCK AND NOT `SELECT … FOR UPDATE` ON THE ROW. A row lock is
// held by ONE connection, and every participant's critical section writes the
// same row through the shared application pool — `createOrUpdateRunTrigger`,
// `markTriggerReleasedInDb`, `markTriggerFiredInDb`. Those writes would arrive
// on a DIFFERENT pooled connection than the one holding the row lock and block
// on it forever: a self-deadlock, in production code, on the ordinary path. The
// advisory lock separates the two concerns — it excludes other CLAIMANTS
// without locking the row against the claimant's own writes — so the critical
// section keeps using the application pool exactly as it does today.
//
// AND WHY THE CLAIM HAS ITS OWN POOL, which is not a tuning choice but the
// thing that makes the design safe. A claim holds a
// connection for the length of its body, and the body needs connections of its
// own. Taken from the SAME pool, N simultaneous claims on N DIFFERENT runs
// occupy every connection and then each waits for one more — a deadlock no lock
// timeout can break, because every advisory lock involved was already granted.
// A dedicated pool removes the interaction entirely: claim connections and body
// connections can never starve each other, and the (max+1)-th claimant is
// refused by `connectionTimeoutMillis` instead of waiting on the body of
// another. That refusal is a normal answer here — see the callers.
//
// WHAT IT CANNOT DO — THE BULLMQ/REDIS BOUNDARY, stated plainly because half of
// each window lives outside Postgres. The claim serializes DECISIONS. It does
// not make a Redis write and a DB write one atom, and it does not reach a job
// BullMQ has already handed to a worker. Concretely:
//   · A `removeJobScheduler` can fail while the stop's stamp stands. That is
//     survivable BY DESIGN and unchanged here: the stop keeps `job_scheduler_id`
//     so the orphan is nameable, and the first tick to arrive takes the claim,
//     reads the stamp, refuses to fire and tears the scheduler down.
//   · A tick already dequeued and INSIDE the claim finishes its fire. A stop
//     pressed at that instant commits immediately after and stops everything
//     from there on. No copy is ever launched under a stop that has already
//     committed, which is the property the claim actually delivers; retracting
//     a launch that has already happened is not something any lock can offer.
//   · A run already enqueued for execution is not recalled by a stop. Cancel
//     schedule never touched the run's own status, by design (plan (A) §7.2) —
//     it stops the schedule, not the work.
// Every participant therefore RE-READS INSIDE THE CLAIM and decides on that
// read, never on the snapshot it arrived with.
// ---------------------------------------------------------------------------

/** Namespace half of the advisory key. Distinct from the org-write kernel's
 *  namespaces, so a trigger claim can never collide with an org lock. Exported
 *  so the serialization suite can watch for a wait on THIS exact key rather
 *  than on "a lock somewhere". */
export const TRIGGER_CLAIM_NAMESPACE = "cinatra:agent-run-trigger";

/** How long a claimant waits for the lock before giving up. Bounds the WAIT,
 *  never the hold — see the note above. */
const TRIGGER_CLAIM_LOCK_TIMEOUT = "15s";

/** Ceiling on SIMULTANEOUS claims across this process. Deliberately small: the
 *  claim is a short critical section on one run's schedule, never a throughput
 *  path, and a low ceiling keeps a pathological body from parking connections. */
const TRIGGER_CLAIM_POOL_MAX = 8;

/** How long the (max+1)-th claimant waits for a claim connection before it is
 *  refused. Refusing beats queueing: every caller has a safe "not now" answer. */
const TRIGGER_CLAIM_CONNECT_TIMEOUT_MS = 10_000;

/** Postgres `lock_not_available` — what `lock_timeout` raises. */
const LOCK_NOT_AVAILABLE = "55P03";

declare global {
  // eslint-disable-next-line no-var
  var __cinatraTriggerClaimPool: Pool | undefined;
}

let claimPoolInstance: Pool | undefined;

function getTriggerClaimPool(): Pool {
  if (claimPoolInstance) return claimPoolInstance;
  if (globalThis.__cinatraTriggerClaimPool) {
    return (claimPoolInstance = globalThis.__cinatraTriggerClaimPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for the trigger claim");
  }
  const pool = new Pool({
    connectionString,
    max: TRIGGER_CLAIM_POOL_MAX,
    connectionTimeoutMillis: TRIGGER_CLAIM_CONNECT_TIMEOUT_MS,
  });
  // Same reason db.ts registers one: pg.Pool emits 'error' when the backend
  // drops an idle connection, which Node otherwise treats as uncaught.
  pool.on("error", (err) => {
    console.error("[trigger-claim] pg pool idle client error:", err.message);
  });
  claimPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraTriggerClaimPool = pool;
  }
  return pool;
}

/**
 * The claim could not be taken. Callers turn this into their own answer — a
 * refusal the reader can act on, or a retryable failure — rather than letting
 * it escape as an unhandled error.
 *
 * Raised for the TWO ways a claimant can fail to get in and for nothing else: a
 * `lock_timeout` on the advisory lock itself, and a claim pool with no free
 * connection. An error from the claim BODY is never translated into this — a
 * caller that reads it as "nothing was written" would be wrong.
 */
export class TriggerClaimUnavailableError extends Error {
  readonly code = "TRIGGER_CLAIM_UNAVAILABLE";
  constructor(runId: string, options?: { cause?: unknown }) {
    super(`the trigger claim for run ${runId} was not available in time`);
    this.name = "TriggerClaimUnavailableError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Run `body` as the only writer deciding about this run's trigger row.
 *
 * The row is re-read INSIDE the claim and handed to `body`, which is the whole
 * contract: whatever the caller believed on the way in, the decision is made on
 * the row as it stands now, and nothing else can change it until `body`
 * returns.
 *
 * The re-read deliberately goes through the APPLICATION pool rather than the
 * claim connection. It is a READ COMMITTED read taken while the claim is held,
 * so it sees every committed write and no other claimant can be mid-write; and
 * routing it through the application pool keeps the claim connection free of
 * row locks, which is what lets `body` write the same row without deadlocking
 * against it.
 *
 * Throws `TriggerClaimUnavailableError` when the claim cannot be taken.
 * Anything `body` throws propagates UNCHANGED, with the claim released.
 */
export async function withTriggerClaim<T>(
  runId: string,
  body: (live: TriggerRecord | null) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await getTriggerClaimPool().connect();
  } catch (err) {
    // No claim connection free within the timeout — nothing was written.
    throw new TriggerClaimUnavailableError(runId, { cause: err });
  }
  try {
    await client.query("BEGIN");
    // A literal, not a bound parameter: `SET` takes none. The value is a module
    // constant and is never request-influenced.
    await client.query(`SET LOCAL lock_timeout = '${TRIGGER_CLAIM_LOCK_TIMEOUT}'`);
    try {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [TRIGGER_CLAIM_NAMESPACE, runId],
      );
    } catch (err) {
      // TRANSLATED HERE AND ONLY HERE. A `55P03` raised by something the BODY
      // does is a different fact and must not be reported as "the claim was
      // unavailable, nothing was written".
      if ((err as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE) {
        throw new TriggerClaimUnavailableError(runId, { cause: err });
      }
      throw err;
    }
    const live = await readRunTriggerByRunId(runId);
    const answer = await body(live);
    await client.query("COMMIT");
    return answer;
  } catch (err) {
    // Releases the advisory lock. The body's own side effects are on other
    // connections and are already committed — this transaction carries no data.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
