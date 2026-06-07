/**
 * Unit tests for trigger-schedule.ts and trigger-release-job.ts.
 *
 * Tests the core trigger scheduling and release behaviors:
 *
 *   scheduleTrigger:
 *     1. immediate → calls markTriggerReleased(runId), returns
 *        { jobSchedulerId: null }.
 *     2. scheduled (future) → enqueues a delayed AGENT_RUN_TRIGGER_RELEASE
 *        job with jobId=`trigger-release-${runId}` and delay=
 *        scheduledAt-now. Returns { jobSchedulerId: id }.
 *     3. scheduled (past) → throws "scheduled time is in the past".
 *     4. recurring → calls queue.upsertJobScheduler with
 *        { pattern, tz } AND { name, data, opts: { attempts: 3,
 *        backoff: { type: "exponential", delay: 5000 } } }.
 *     5. cancelTriggerSchedule(recurring, id) → removeJobScheduler(id).
 *     6. cancelTriggerSchedule(scheduled, id) → getJob(id).remove().
 *
 *   runAgentRunTriggerReleaseJob:
 *     7. type='scheduled' → markTriggerReleased + transitionRunStatus
 *        armed→queued + enqueue AGENT_BUILDER_EXECUTION.
 *     8. type='recurring' → creates a NEW pending_input run with cloned
 *        templateId+inputParams+runBy, arms it as immediate, transitions
 *        pending_input→queued, enqueues execution for the NEW runId.
 *     9. enabled === false → unschedule (recurring) + skip release.
 *    10. Idempotency for scheduled — second call swallows
 *        stale_from_status RunTransitionError; only one execution
 *        enqueue total.
 *
 * Mocking strategy: spy on the in-memory stub BullMQ queue from
 * tests/__stubs__/background-jobs.ts (vi.spyOn calls expose the call
 * args). Actual DB rows are exercised against the live worktree
 * Postgres schema (per the trigger-store / trigger-gate test pattern).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  scheduleTrigger,
  cancelTriggerSchedule,
} from "../trigger-schedule";
import { runAgentRunTriggerReleaseJob } from "../trigger-release-job";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
} from "../trigger-store";
import {
  createAgentRun,
  readAgentRunById,
  transitionRunStatus,
} from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns } from "../schema";
import {
  ensureBackgroundJobRuntime,
  getRedisConnection,
  // @ts-expect-error — __stubInternals is exposed on the test stub only
  __stubInternals,
} from "@/lib/background-jobs";

const REDIS_KEY = (runId: string) => `trigger:released:${runId}`;

// Fixture orgId required by the run schema.
const TEST_ORG_ID = "org-test";

async function ensureParentRun(): Promise<string> {
  const id = `test-trigger-schedule-${randomUUID()}`;
  await createAgentRun({
    id,
    templateId: `tmpl-${randomUUID()}`,
    inputParams: { hello: "world" },
    orgId: TEST_ORG_ID,
  });
  return id;
}

describe("trigger-schedule + trigger-release-job", () => {
  const createdRunIds: string[] = [];

  beforeAll(() => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "trigger-schedule.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
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
      // ignore
    });
  });

  // --------------------------------------------------------------------------
  // Behavior 1: immediate triggers mark released and return null schedulerId
  // --------------------------------------------------------------------------
  it("scheduleTrigger(immediate) calls markTriggerReleased and returns null jobSchedulerId", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
      enabled: true,
    });

    const result = await scheduleTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
    });
    expect(result.jobSchedulerId).toBeNull();

    const redis = await getRedisConnection();
    expect(await redis.exists(REDIS_KEY(runId))).toBe(1);

    const row = await readRunTriggerByRunId(runId);
    expect(row?.releasedAt).toBeInstanceOf(Date);
  });

  // --------------------------------------------------------------------------
  // Behavior 2: scheduled future → enqueueBackgroundJob with delay + jobId
  // --------------------------------------------------------------------------
  it("scheduleTrigger(scheduled, future) enqueues a delayed BullMQ job", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    const runtime = await ensureBackgroundJobRuntime();
    const addSpy = vi.spyOn(runtime.queue, "add");

    const future = new Date(Date.now() + 60_000); // +1 min
    const result = await scheduleTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: future,
      timezone: "UTC",
    });

    expect(result.jobSchedulerId).toBe(`trigger-release-${runId}`);
    expect(addSpy).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addSpy.mock.calls[0];
    expect(name).toBe("agent-run-trigger-release");
    expect((data as { runId: string }).runId).toBe(runId);
    expect(opts?.jobId).toBe(`trigger-release-${runId}`);
    expect(typeof opts?.delay).toBe("number");
    expect(opts!.delay!).toBeGreaterThan(0);
    expect(opts!.delay!).toBeLessThanOrEqual(60_000);

    addSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 3: scheduled past → throws
  // --------------------------------------------------------------------------
  it("scheduleTrigger(scheduled, past) throws", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    const past = new Date(Date.now() - 60_000);
    await expect(
      scheduleTrigger({
        runId,
        triggerType: "scheduled",
        scheduledAt: past,
        timezone: "UTC",
      }),
    ).rejects.toThrow(/scheduled time is in the past/);
  });

  // --------------------------------------------------------------------------
  // Behavior 4: recurring → queue.upsertJobScheduler with the cron + tz +
  //              attempts/backoff opts
  // --------------------------------------------------------------------------
  it("scheduleTrigger(recurring) calls upsertJobScheduler with cron, tz, attempts, exponential backoff", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    const runtime = await ensureBackgroundJobRuntime();
    const upsertSpy = vi.spyOn(runtime.queue, "upsertJobScheduler");

    const result = await scheduleTrigger({
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      timezone: "Europe/London",
    });
    expect(result.jobSchedulerId).toBe(`trigger-release-${runId}`);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [schedulerId, repeatOpts, jobTemplate] = upsertSpy.mock.calls[0];
    expect(schedulerId).toBe(`trigger-release-${runId}`);
    expect((repeatOpts as { pattern: string }).pattern).toBe("0 9 * * MON");
    expect((repeatOpts as { tz: string }).tz).toBe("Europe/London");
    expect((jobTemplate as { name: string }).name).toBe(
      "agent-run-trigger-release",
    );
    expect((jobTemplate as { data: { runId: string } }).data.runId).toBe(
      runId,
    );
    const opts = (jobTemplate as {
      opts: {
        attempts: number;
        backoff: { type: string; delay: number };
      };
    }).opts;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff.type).toBe("exponential");
    expect(opts.backoff.delay).toBe(5_000);

    upsertSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 5: cancelTriggerSchedule(recurring) → removeJobScheduler
  // --------------------------------------------------------------------------
  it("cancelTriggerSchedule(recurring) calls removeJobScheduler with the same id", async () => {
    const runtime = await ensureBackgroundJobRuntime();
    const removeSpy = vi.spyOn(runtime.queue, "removeJobScheduler");

    await cancelTriggerSchedule({
      jobSchedulerId: "trigger-release-some-run",
      triggerType: "recurring",
    });
    expect(removeSpy).toHaveBeenCalledWith("trigger-release-some-run");
    removeSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 6: cancelTriggerSchedule(scheduled) → getJob(id).remove()
  // --------------------------------------------------------------------------
  it("cancelTriggerSchedule(scheduled) calls getJob(id).remove()", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    const future = new Date(Date.now() + 60_000);
    await scheduleTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: future,
      timezone: "UTC",
    });

    const runtime = await ensureBackgroundJobRuntime();
    const getJobSpy = vi.spyOn(runtime.queue, "getJob");

    await cancelTriggerSchedule({
      jobSchedulerId: `trigger-release-${runId}`,
      triggerType: "scheduled",
    });
    expect(getJobSpy).toHaveBeenCalledWith(`trigger-release-${runId}`);
    // Verify job.remove() was actually invoked — the in-memory stub deletes
    // the entry on remove(), so the job must no longer appear in the map
    expect(
      __stubInternals._scheduledJobs.has(`trigger-release-${runId}`),
    ).toBe(false);
    getJobSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 7: scheduled fire → mark released + transition armed→queued +
  //              enqueue AGENT_BUILDER_EXECUTION
  // --------------------------------------------------------------------------
  it("runAgentRunTriggerReleaseJob (scheduled) marks released, transitions armed→queued, enqueues execution", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: new Date(Date.now() + 60_000),
      timezone: "UTC",
      enabled: true,
    });
    // Move the run into 'armed' so the release job's transition can succeed.
    // queued (default) → pending_input → armed
    await transitionRunStatus(runId, "queued", "pending_input");
    await transitionRunStatus(runId, "pending_input", "armed");

    const runtime = await ensureBackgroundJobRuntime();
    const addSpy = vi.spyOn(runtime.queue, "add");

    await runAgentRunTriggerReleaseJob({ runId }, "stub-job-id");

    // Redis flag set
    const redis = await getRedisConnection();
    expect(await redis.exists(REDIS_KEY(runId))).toBe(1);
    // DB releasedAt set
    const row = await readRunTriggerByRunId(runId);
    expect(row?.releasedAt).toBeInstanceOf(Date);
    // Run transitioned to queued
    const updated = await readAgentRunById(runId);
    expect(updated?.status).toBe("queued");
    // Execution job enqueued
    const executionCalls = addSpy.mock.calls.filter(
      ([name]) => name === "agent-builder-execution",
    );
    expect(executionCalls).toHaveLength(1);
    expect((executionCalls[0][1] as { runId: string }).runId).toBe(runId);
    expect(executionCalls[0][2]?.jobId).toBe(`agent-builder-${runId}`);

    addSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 8: recurring fire → clone run + arm immediate + enqueue NEW run
  // --------------------------------------------------------------------------
  it("runAgentRunTriggerReleaseJob (recurring) clones the run, arms immediate, enqueues execution for NEW runId", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      timezone: "UTC",
      enabled: true,
      jobSchedulerId: `trigger-release-${runId}`,
    });

    const runtime = await ensureBackgroundJobRuntime();
    const addSpy = vi.spyOn(runtime.queue, "add");

    await runAgentRunTriggerReleaseJob({ runId }, "stub-job-id");

    const original = await readAgentRunById(runId);
    expect(original?.status).toBe("queued"); // schedule-defining run unchanged

    // Find the new run via the enqueue call
    const executionCalls = addSpy.mock.calls.filter(
      ([name]) => name === "agent-builder-execution",
    );
    expect(executionCalls).toHaveLength(1);
    const newRunId = (executionCalls[0][1] as { runId: string }).runId;
    expect(newRunId).not.toBe(runId);
    createdRunIds.push(newRunId);

    const newRun = await readAgentRunById(newRunId);
    expect(newRun).not.toBeNull();
    expect(newRun!.status).toBe("queued"); // pending_input → queued
    expect(newRun!.templateId).toBe(original!.templateId);
    expect(newRun!.inputParams).toEqual({ hello: "world" });

    // New run has its own immediate trigger, marked released
    const newTrigger = await readRunTriggerByRunId(newRunId);
    expect(newTrigger?.triggerType).toBe("immediate");
    expect(newTrigger?.releasedAt).toBeInstanceOf(Date);

    addSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 9: enabled=false → unschedule (recurring) + skip release
  // --------------------------------------------------------------------------
  it("runAgentRunTriggerReleaseJob unschedules a recurring trigger when enabled=false and skips release", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      timezone: "UTC",
      enabled: false,
      jobSchedulerId: `trigger-release-${runId}`,
    });

    const runtime = await ensureBackgroundJobRuntime();
    const removeSpy = vi.spyOn(runtime.queue, "removeJobScheduler");
    const addSpy = vi.spyOn(runtime.queue, "add");

    await runAgentRunTriggerReleaseJob({ runId }, "stub-job-id");

    expect(removeSpy).toHaveBeenCalledWith(`trigger-release-${runId}`);

    // No release: Redis flag NOT set; DB releasedAt still null
    const redis = await getRedisConnection();
    expect(await redis.exists(REDIS_KEY(runId))).toBe(0);
    const row = await readRunTriggerByRunId(runId);
    expect(row?.releasedAt).toBeNull();
    // No execution enqueue
    const executionCalls = addSpy.mock.calls.filter(
      ([name]) => name === "agent-builder-execution",
    );
    expect(executionCalls).toHaveLength(0);

    removeSpy.mockRestore();
    addSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Behavior 10: Idempotency — twin scheduled fire only enqueues execution once
  // --------------------------------------------------------------------------
  it("runAgentRunTriggerReleaseJob (scheduled) is idempotent — twin fire enqueues execution only once", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: new Date(Date.now() + 60_000),
      timezone: "UTC",
      enabled: true,
    });
    await transitionRunStatus(runId, "queued", "pending_input");
    await transitionRunStatus(runId, "pending_input", "armed");

    const runtime = await ensureBackgroundJobRuntime();
    const addSpy = vi.spyOn(runtime.queue, "add");

    // Fire twice
    await runAgentRunTriggerReleaseJob({ runId }, "stub-job-id-1");
    await runAgentRunTriggerReleaseJob({ runId }, "stub-job-id-2");

    const executionCalls = addSpy.mock.calls.filter(
      ([name]) => name === "agent-builder-execution",
    );
    // Only one enqueue — second armed→queued is stale_from_status (run is
    // already queued) and gets swallowed.
    expect(executionCalls).toHaveLength(1);

    addSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Cleanup helper test (also exercises that delete works after release)
  // --------------------------------------------------------------------------
  it("deleteRunTriggerByRunId removes a released trigger row", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
      enabled: true,
    });
    await scheduleTrigger({
      runId,
      triggerType: "immediate",
      timezone: "UTC",
    });
    await deleteRunTriggerByRunId(runId);
    expect(await readRunTriggerByRunId(runId)).toBeNull();
  });
});
