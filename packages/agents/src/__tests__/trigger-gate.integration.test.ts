/**
 * Unit tests for trigger-gate.ts.
 *
 * Tests the trigger release gate behaviors:
 *   1. isTriggerReleased(runId) returns false for a runId with no trigger row.
 *   2. isTriggerReleased(runId) returns true after markTriggerReleased(runId)
 *      (Redis flag is set).
 *   3. After clearing the Redis flag manually, isTriggerReleased(runId) STILL
 *      returns true because the DB row's releasedAt is non-null (DB fallback
 *      works AND primes the cache).
 *   4. markTriggerReleased(runId) sets BOTH the Redis flag AND the DB
 *      releasedAt column.
 *   5. The Redis key format is exactly `trigger:released:${runId}`.
 *   6. Redis TTL is set to ~7 days.
 *
 * Uses the in-memory Redis stub from tests/__stubs__/background-jobs.ts via
 * the vitest alias for @/lib/background-jobs. createOrUpdateRunTrigger /
 * readRunTriggerByRunId / deleteRunTriggerByRunId hit the live worktree DB
 * (per the trigger-store test pattern) so we exercise the FK-bound row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { isTriggerReleased, markTriggerReleased } from "../trigger-gate";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
} from "../trigger-store";
import { createAgentRun } from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns } from "../schema";
import {
  getRedisConnection,
  // @ts-expect-error — __stubInternals is exposed on the test stub only
  __stubInternals,
} from "@/lib/background-jobs";

const REDIS_KEY = (runId: string) => `trigger:released:${runId}`;
const TTL_SECONDS = 7 * 24 * 60 * 60;

// Fixture orgId satisfies NOT NULL constraints on agent runs.
const TEST_ORG_ID = "org-test";

async function ensureParentRun(): Promise<string> {
  const id = `test-trigger-gate-${randomUUID()}`;
  await createAgentRun({
    id,
    templateId: `tmpl-${randomUUID()}`,
    inputParams: {},
    orgId: TEST_ORG_ID,
  });
  return id;
}

describe("trigger-gate", () => {
  const createdRunIds: string[] = [];

  beforeAll(() => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "trigger-gate.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
      );
    }
  });

  afterAll(async () => {
    for (const id of createdRunIds) {
      try {
        await db.delete(agentRuns).where(eq(agentRuns.id, id));
      } catch {
        // ignore
      }
    }
    await agentBuilderPool.end().catch(() => {
      // already closed
    });
  });

  // --------------------------------------------------------------------------
  // Behavior 1: false when no row exists
  // --------------------------------------------------------------------------
  it("returns false for a runId with no trigger row", async () => {
    const runId = `nonexistent-${randomUUID()}`;
    // Make sure the stub Redis is empty for this key
    const redis = await getRedisConnection();
    await redis.del(REDIS_KEY(runId));

    const released = await isTriggerReleased(runId);
    expect(released).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Behavior 2 + 4 + 5 + 6: markTriggerReleased writes Redis + DB; key format; TTL
  // --------------------------------------------------------------------------
  it("markTriggerReleased sets BOTH the Redis flag and the DB releasedAt column with the documented key format and ~7-day TTL", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    // Pre-create the trigger row (config-only) so markTriggerReleasedInDb
    // has a row to update. (markTriggerReleasedInDb uses UPDATE, which is a
    // no-op if no row exists.)
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
      enabled: true,
    });

    const redis = await getRedisConnection();
    // Sanity: gate is closed before
    expect(await redis.exists(REDIS_KEY(runId))).toBe(0);

    await markTriggerReleased(runId);

    // Behavior 2 + 5: gate is now open via Redis at exact key
    expect(await redis.exists(REDIS_KEY(runId))).toBe(1);

    // Behavior 6: TTL is approximately 7 days (within a 5-second band of TTL_SECONDS)
    const ttl = await redis.ttl(REDIS_KEY(runId));
    expect(ttl).toBeGreaterThan(TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(TTL_SECONDS);

    // Behavior 4: DB releasedAt is also set
    const row = await readRunTriggerByRunId(runId);
    expect(row).not.toBeNull();
    expect(row!.releasedAt).toBeInstanceOf(Date);

    // isTriggerReleased now returns true via the Redis fast path
    expect(await isTriggerReleased(runId)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Behavior 3: DB fallback primes cache after Redis is cleared
  // --------------------------------------------------------------------------
  it("falls back to DB and primes Redis when the Redis flag is missing but DB releasedAt is non-null", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    // Set the trigger up + release it (writes both Redis + DB)
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
      enabled: true,
    });
    await markTriggerReleased(runId);

    // Now manually evict the Redis flag (simulate cache flush / Redis restart)
    const redis = await getRedisConnection();
    await redis.del(REDIS_KEY(runId));
    expect(await redis.exists(REDIS_KEY(runId))).toBe(0);

    // isTriggerReleased should still return true (DB fallback)
    expect(await isTriggerReleased(runId)).toBe(true);

    // …and it should have primed the Redis cache so subsequent calls hit the
    // fast path (verifiable by exists=1 again)
    expect(await redis.exists(REDIS_KEY(runId))).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Bonus: deleteRunTriggerByRunId clears DB row; isTriggerReleased returns false
  //   (sanity check that the gate-closed state is reachable after release+cleanup)
  // --------------------------------------------------------------------------
  it("returns false after the trigger row is deleted and Redis flag is cleared", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
      enabled: true,
    });
    await markTriggerReleased(runId);

    const redis = await getRedisConnection();
    await redis.del(REDIS_KEY(runId));
    await deleteRunTriggerByRunId(runId);

    expect(await isTriggerReleased(runId)).toBe(false);
  });
});
