import "server-only";
import { getRedisConnection } from "@/lib/background-jobs";
import { readRunTriggerByRunId, markTriggerReleasedInDb } from "./trigger-store";

// ---------------------------------------------------------------------------
// Trigger gate backed by a Redis fast path and DB fallback.
// ---------------------------------------------------------------------------
// The gate state is dual-stored:
//   - Redis EXISTS trigger:released:{runId} -> hot path (every step boundary)
//   - Postgres agent_run_triggers.released_at -> durable source of truth
//
// Reads check Redis first; on a cache miss the DB row is consulted and the
// Redis cache is primed. Writes update both stores (idempotent).
//
// 7-day TTL is consistent with run-instance lifetime; longer-running
// orchestrator runs re-prime on next read.
// ---------------------------------------------------------------------------

const REDIS_KEY = (runId: string) => `trigger:released:${runId}`;
const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Returns true if the trigger gate has been released for `runId`.
 * Reads Redis first (hot path); falls back to DB and primes Redis on a cache miss.
 */
export async function isTriggerReleased(runId: string): Promise<boolean> {
  const redis = await getRedisConnection();
  const exists = await redis.exists(REDIS_KEY(runId));
  if (exists === 1) return true;

  const row = await readRunTriggerByRunId(runId);
  if (row?.releasedAt) {
    // Prime the Redis cache so subsequent calls hit the fast path.
    // Wrap in try/catch: a Redis write failure must not suppress the correct
    // boolean return; the DB is the source of truth. Log so the latency impact
    // from repeated DB fallback is visible in logs.
    try {
      await redis.set(REDIS_KEY(runId), "1", "EX", TTL_SECONDS);
    } catch (err) {
      console.warn(
        "[trigger-gate] Redis cache-prime failed; DB fallback will repeat on next call",
        err,
      );
    }
    return true;
  }
  return false;
}

/**
 * Marks the trigger gate released. Writes Redis flag + DB releasedAt
 * (both idempotent; safe to retry).
 */
export async function markTriggerReleased(runId: string): Promise<void> {
  const redis = await getRedisConnection();
  await redis.set(REDIS_KEY(runId), "1", "EX", TTL_SECONDS);
  await markTriggerReleasedInDb(runId);
}

/**
 * Clears the Redis fast-path flag for `runId` (cinatra#2485 C).
 *
 * COMPENSATION ONLY. Deleting the `agent_run_triggers` row removes the DURABLE
 * half of the gate (`released_at`), but the Redis key outlives it for up to the
 * 7-day TTL — and `isTriggerReleased` checks Redis FIRST, so a run whose trigger
 * was rolled back would still read as "already released". A later re-trigger on
 * that run would then skip its wait and fire immediately instead of on schedule.
 *
 * Idempotent, and deliberately best-effort: the DB row is the source of truth,
 * and the caller is already unwinding a refused operation, so a Redis outage
 * must not mask the refusal it is compensating for.
 */
export async function clearTriggerReleased(runId: string): Promise<void> {
  try {
    const redis = await getRedisConnection();
    await redis.del(REDIS_KEY(runId));
  } catch (err) {
    console.warn(
      "[trigger-gate] failed to clear the released flag for run",
      runId,
      "— the DB row is authoritative, but the cached flag may survive its TTL:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
