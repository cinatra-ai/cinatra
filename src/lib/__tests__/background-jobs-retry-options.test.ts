import { beforeEach, describe, expect, it, vi } from "vitest";

// `enqueueBackgroundJob` `attempts` / `backoff` widening. We don't spin up
// BullMQ; we mock the queue and assert what lands in
// `queue.add(name, payload, jobOpts)`.
//
// The contract under test:
//   - OPT-IN: a caller that passes `attempts` / `backoff` has them
//     reach `queue.add`'s options;
//   - DEFAULT UNCHANGED: a caller that omits them produces jobOpts
//     with NEITHER key (so BullMQ keeps its `attempts: 1` run-once
//     default — existing email/webhook/blog jobs are NOT retroactively
//     retried).

const queueAddMock = vi.fn().mockResolvedValue({ id: "j-1" });

vi.mock("bullmq", () => {
  class FakeQueue {
    add = queueAddMock;
    getJob = vi.fn().mockResolvedValue(null);
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

describe("enqueueBackgroundJob — attempts/backoff opt-in", () => {
  beforeEach(() => {
    queueAddMock.mockClear();
  });

  it("forwards `attempts` + `backoff` to queue.add when explicitly passed", async () => {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT,
      {},
      {
        // System-scope enqueue so the auto-attribution cascade no-ops
        // and the test stays pure (no headers()/session reach).
        inheritActorContext: false,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [, , jobOpts] = queueAddMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(jobOpts.attempts).toBe(3);
    expect(jobOpts.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("does NOT inject attempts/backoff when the caller omits them (BullMQ default = run-once)", async () => {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT,
      {},
      { inheritActorContext: false },
    );
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [, , jobOpts] = queueAddMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    // The keys must be ABSENT (not `undefined`) — an explicit
    // `attempts: undefined` would still be a no-op for BullMQ, but
    // asserting absence proves the widening is purely additive and
    // existing callers are byte-identical.
    expect("attempts" in jobOpts).toBe(false);
    expect("backoff" in jobOpts).toBe(false);
  });

  it("attempts/backoff also flow through the skipWorker bootstrap path", async () => {
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT,
      {},
      {
        skipWorker: true,
        inheritActorContext: false,
        jobId: "test-loop",
        attempts: 5,
        backoff: 2000,
      },
    );
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [, , jobOpts] = queueAddMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(jobOpts.attempts).toBe(5);
    expect(jobOpts.backoff).toBe(2000);
    // skipWorker / inheritActorContext must be stripped from jobOpts
    // (they are not BullMQ options) — regression guard.
    expect("skipWorker" in jobOpts).toBe(false);
    expect("inheritActorContext" in jobOpts).toBe(false);
  });
});
