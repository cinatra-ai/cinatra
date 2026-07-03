// Reliability coverage for the shared recurring-loop helper (cinatra#849).
//
// runRecurringLoop is the single choke point that owns every self-rescheduling
// loop's error policy: a throw from the cycle `run()` — a pre-work dynamic
// import / registration failure OR an unswallowed cycle error — must NOT kill
// the loop. Before this fix `run()` was awaited with no wrapping try/catch, so
// a throw skipped `moveToDelayed`, the job failed, and with the default
// `attempts: 1` it was never retried — the loop silently died until the next
// boot re-seeded it (the graphiti-projection-repair 30s loop being the reported
// case, where `ensureCrmSyncRegistrations()` + the dynamic import sat OUTSIDE
// the handler's inner try). The helper now reports the throw to the error
// reporter and ALWAYS re-delays.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelayedError, type Job } from "bullmq";

vi.mock("server-only", () => ({}));

// The recurring-loop helper reports a thrown cycle to @cinatra-ai/errors/server
// via a fire-and-forget dynamic import; intercept it to assert the surfacing.
const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(
    (
      _err: unknown,
      _meta: { jobName?: string; jobId?: string | number; queueName?: string },
    ): Promise<void> => Promise.resolve(),
  ),
}));
vi.mock("@cinatra-ai/errors/server", () => ({
  captureBackgroundJobError: captureMock,
}));

// For the GRAPHITI dispatcher integration test.
const { processProjectionOutboxMock } = vi.hoisted(() => ({
  processProjectionOutboxMock: vi.fn(async () => ({ processed: 0, failed: 0 })),
}));
vi.mock("@cinatra-ai/objects/graphiti-projector", () => ({
  processProjectionOutbox: processProjectionOutboxMock,
}));

import { runRecurringLoop } from "@/lib/background-jobs-registry";
import {
  BACKGROUND_JOB_NAMES,
  GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";
import * as backgroundJobs from "@/lib/background-jobs";

function makeLoopJob(id: string, moveToDelayed: ReturnType<typeof vi.fn>): Job {
  return {
    id,
    name: "recurring-loop-test",
    queueName: "cinatra-bg-test",
    token: "test-token",
    moveToDelayed,
  } as unknown as Job;
}

beforeEach(() => {
  captureMock.mockClear();
  processProjectionOutboxMock.mockReset();
  processProjectionOutboxMock.mockResolvedValue({ processed: 0, failed: 0 });
});

describe("runRecurringLoop error policy (cinatra#849)", () => {
  it("re-delays the canonical loop even when run() throws — a pre-work throw can no longer kill the loop", async () => {
    const moveToDelayed = vi.fn(async () => {});
    const job = makeLoopJob("loop-1", moveToDelayed);

    // A throw here models the graphiti pre-`try` failure (import/registration).
    await expect(
      runRecurringLoop({
        job,
        loopJobId: "loop-1",
        delayMs: 30_000,
        label: "test",
        run: async () => {
          throw new Error("pre-work import failed");
        },
      }),
    ).rejects.toBeInstanceOf(DelayedError);

    // The loop still rescheduled itself despite the throw.
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    // …and the failure was surfaced to the error reporter (fire-and-forget).
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    expect(captureMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(captureMock.mock.calls[0]?.[1]).toMatchObject({
      jobName: "recurring-loop-test",
      jobId: "loop-1",
      queueName: "cinatra-bg-test",
    });
  });

  it("happy path unchanged: re-delays + throws DelayedError, with NO error report", async () => {
    const moveToDelayed = vi.fn(async () => {});
    const job = makeLoopJob("loop-1", moveToDelayed);

    await expect(
      runRecurringLoop({
        job,
        loopJobId: "loop-1",
        delayMs: 30_000,
        label: "test",
        run: async () => {
          /* resolves cleanly */
        },
      }),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    // run() never threw, so the catch (and thus the reporter) never ran.
    await Promise.resolve();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("drains an anonymous duplicate that throws: reports, runs once, does NOT re-delay", async () => {
    const moveToDelayed = vi.fn(async () => {});
    // id != canonical loopJobId → legacy/anonymous duplicate.
    const job = makeLoopJob("anonymous-duplicate", moveToDelayed);

    await expect(
      runRecurringLoop({
        job,
        loopJobId: "canonical-loop-id",
        delayMs: 30_000,
        label: "test",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBeUndefined();

    // Duplicate must not perpetuate the loop…
    expect(moveToDelayed).not.toHaveBeenCalled();
    // …but its failure is still surfaced.
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
  });

  it("a re-delay failure after a thrown cycle still does not throw out of the loop (Redis blip)", async () => {
    const moveToDelayed = vi.fn(async () => {
      throw new Error("redis blip on moveToDelayed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = makeLoopJob("loop-1", moveToDelayed);

    await expect(
      runRecurringLoop({
        job,
        loopJobId: "loop-1",
        delayMs: 30_000,
        label: "test",
        run: async () => {
          throw new Error("cycle boom");
        },
      }),
    ).resolves.toBeUndefined(); // no throw escapes — the worker won't hard-fail

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled(); // "[test] re-delay failed"
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    warn.mockRestore();
    error.mockRestore();
  });
});

describe("GRAPHITI_PROJECTION_REPAIR loop survives a failing cycle (the reported case)", () => {
  it("re-delays the canonical loop + reports to Sentry when the outbox cycle throws", async () => {
    processProjectionOutboxMock.mockRejectedValueOnce(new Error("outbox boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const moveToDelayed = vi.fn(async () => {});
    const job = {
      name: BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR,
      data: {},
      id: GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID, // canonical loop id → re-delay path
      queueName: "cinatra-bg-test",
      token: "test-token",
      moveToDelayed,
    } as unknown as Parameters<typeof dispatchBackgroundJob>[0];

    await expect(dispatchBackgroundJob(job)).rejects.toBeInstanceOf(DelayedError);

    // The 30s loop rescheduled itself instead of dying…
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    // …and the cycle failure reached the error reporter.
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    expect(captureMock.mock.calls[0]?.[1]).toMatchObject({
      jobName: BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR,
    });
    error.mockRestore();
  });
});

describe("dead child-process cancellation subsystem removed (cinatra#849 finding 2)", () => {
  it("no longer exports the never-called child-process / child-job helpers", () => {
    const surface = backgroundJobs as unknown as Record<string, unknown>;
    expect(surface.registerBackgroundJobChildProcess).toBeUndefined();
    expect(surface.unregisterBackgroundJobChildProcess).toBeUndefined();
    expect(surface.enqueueChildJob).toBeUndefined();
    // The live AbortController-based cancellation surface is retained.
    expect(typeof surface.cancelBackgroundJob).toBe("function");
    expect(typeof surface.registerBackgroundJobAbortController).toBe("function");
  });
});
