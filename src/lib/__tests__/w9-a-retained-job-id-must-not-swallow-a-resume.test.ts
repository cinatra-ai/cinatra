/**
 * cinatra#3033 fix leg 3 — the setup-resume hand-off deadlock, at its enqueue
 * seam.
 *
 * WHAT WENT WRONG ON THE REAL RUNS
 *
 * A setup approval hands the run back to the worker with
 *
 *     enqueueBackgroundJob(AGENT_BUILDER_EXECUTION, { runId, resumedFromSetup: true },
 *                          { jobId: `resume-setup-${runId}` })
 *
 * — a job id that is constant for the WHOLE run, while the queue retains
 * settled jobs (`removeOnComplete: 200`, see `background-jobs.ts`). BullMQ's
 * `Queue.add` writes the job hash with HSETNX, so adding a job whose id is
 * already on the queue is a SILENT no-op that returns the old job. An agent
 * whose setup asks for two fields therefore parks, resumes once, parks again —
 * and its SECOND approval flips the run `pending_approval -> queued` and then
 * enqueues nothing at all. The run sits at `queued` with no job, no trigger row
 * and no error, and every further press of the same form is refused with
 * `... is not pending_approval (current status: queued)`.
 *
 * `enqueueBackgroundJob` already carries the remedy — `overwriteIfStale`, whose
 * own comment names this exact trap ("so BullMQ HSETNX doesn't silently
 * no-op") — but only the `skipWorker: true` bootstrap branch ever read it. On
 * the normal worker path the key was not even destructured out of the options,
 * so it was handed to BullMQ as a stray option and did nothing.
 *
 * These tests pin the option's behaviour ON THE WORKER PATH: a SETTLED job of
 * that id is cleared so the new leg really enqueues, a LIVE one is left alone
 * so an in-flight leg still dedups, neither of this function's own option keys
 * ever reaches BullMQ, and the retained entry disappearing between the read and
 * the removal (eviction by `removeOnComplete`, another producer) is tolerated
 * instead of being raised into a caller that has already committed a database
 * transition.
 *
 * The setup-approval resume no longer leans on this option — clearing a settled
 * entry cannot help a leg whose predecessor is still ACTIVE, so that caller
 * mints a per-leg job id (see `review-task-actions.ts`). The option remains
 * live for the callers that DO want one durable id per subject (the marketplace
 * catalog sync, the boot loops), and it was inert for every one of them on this
 * path until now.
 *
 *   pnpm vitest run src/lib/__tests__/w9-a-retained-job-id-must-not-swallow-a-resume.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queueAddMock = vi.fn().mockResolvedValue({ id: "j-1" });
const getJobMock = vi.fn().mockResolvedValue(null);
const removeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("bullmq", () => {
  class FakeQueue {
    add = queueAddMock;
    getJob = getJobMock;
    waitUntilReady = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
  }
  class FakeWorker {
    on() {
      return this;
    }
    waitUntilReady() {
      return Promise.resolve(undefined);
    }
    close() {
      return Promise.resolve();
    }
  }
  class FakeQueueEvents {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
});

vi.mock("ioredis", () => ({
  default: class FakeIORedis {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve("OK");
    }
  },
}));

// No-op the top-level host-adapter side-effect import (DB/auth wiring).
vi.mock("@/lib/notifications-host", () => ({}));

import { BACKGROUND_JOB_NAMES, enqueueBackgroundJob } from "../background-jobs";

/** The shape the real setup-approval resume enqueues (review-task-actions.ts). */
const RESUME_JOB_ID = "resume-setup-run-two-field";

function lastJobOpts(): Record<string, unknown> {
  const call = queueAddMock.mock.calls.at(-1) as
    | [string, unknown, Record<string, unknown>]
    | undefined;
  return call?.[2] ?? {};
}

describe("enqueueBackgroundJob — overwriteIfStale on the WORKER path (cinatra#3033)", () => {
  beforeEach(() => {
    queueAddMock.mockClear();
    removeMock.mockClear();
    getJobMock.mockReset();
    getJobMock.mockResolvedValue(null);
  });

  it("clears a RETAINED COMPLETED job of the same id, so the second setup leg is really enqueued", async () => {
    getJobMock.mockResolvedValue({
      getState: async () => "completed",
      remove: removeMock,
    });

    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "run-two-field", resumedFromSetup: true },
      { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
    );

    expect(getJobMock).toHaveBeenCalledWith(RESUME_JOB_ID);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(lastJobOpts().jobId).toBe(RESUME_JOB_ID);
  });

  it("clears a RETAINED FAILED job of the same id too", async () => {
    getJobMock.mockResolvedValue({
      getState: async () => "failed",
      remove: removeMock,
    });

    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "run-two-field", resumedFromSetup: true },
      { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
    );

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a LIVE job of the same id alone — an in-flight leg still dedups", async () => {
    for (const state of ["waiting", "active", "delayed"] as const) {
      removeMock.mockClear();
      getJobMock.mockResolvedValue({
        getState: async () => state,
        remove: removeMock,
      });

      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
        { runId: "run-two-field", resumedFromSetup: true },
        { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
      );

      expect(removeMock, `a ${state} job must not be removed`).not.toHaveBeenCalled();
    }
  });

  it("never hands its own option keys to BullMQ", async () => {
    getJobMock.mockResolvedValue(null);

    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "run-two-field", resumedFromSetup: true },
      { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
    );

    const jobOpts = lastJobOpts();
    expect(Object.hasOwn(jobOpts, "overwriteIfStale")).toBe(false);
    expect(Object.hasOwn(jobOpts, "skipWorker")).toBe(false);
    expect(Object.hasOwn(jobOpts, "actorContext")).toBe(false);
    expect(Object.hasOwn(jobOpts, "inheritActorContext")).toBe(false);
  });

  it("tolerates the retained job disappearing between the read and the removal", async () => {
    // BullMQ's `Job.remove()` throws whenever its script reports that nothing
    // was removed — which includes the entry being evicted by
    // `removeOnComplete` (or removed by another producer) in this exact window.
    // The job being gone IS the outcome the flag wants, and the caller has
    // usually already committed a transition, so this must not raise.
    const goneJob = {
      getState: async () => "completed",
      remove: vi.fn().mockRejectedValue(new Error("could not remove job")),
    };
    getJobMock.mockResolvedValueOnce(goneJob).mockResolvedValueOnce(null);

    await expect(
      enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
        { runId: "run-two-field", resumedFromSetup: true },
        { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
      ),
    ).resolves.toBeDefined();

    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it("re-raises when the removal fails and the settled job is still there", async () => {
    // A genuine Redis / removal failure is NOT swallowed: the add that follows
    // would silently no-op, so the caller must hear about it.
    const stuck = {
      getState: async () => "completed",
      remove: vi.fn().mockRejectedValue(new Error("__redis_down__")),
    };
    getJobMock.mockResolvedValue(stuck);

    await expect(
      enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
        { runId: "run-two-field", resumedFromSetup: true },
        { inheritActorContext: false, jobId: RESUME_JOB_ID, overwriteIfStale: true },
      ),
    ).rejects.toThrow(/__redis_down__/);

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("is inert without the flag — a retained job is not even read", async () => {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
      { runId: "run-two-field" },
      { inheritActorContext: false, jobId: RESUME_JOB_ID },
    );

    expect(getJobMock).not.toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });
});
