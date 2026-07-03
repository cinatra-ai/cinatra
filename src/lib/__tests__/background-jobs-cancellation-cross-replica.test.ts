// Multi-replica cancellation contract (cinatra#849 finding 3).
//
// Cancellation is cross-replica by construction: `cancelBackgroundJob` writes
// the cancellation flag to the SHARED Postgres `metadata` table
// (markBackgroundJobCancellationRequested → writeMetadataValueToDatabase), and
// every replica's `registerBackgroundJobAbortController` starts a 750ms poller
// that reads that same shared flag (isBackgroundJobCancellationRequested) and
// aborts its LOCAL AbortController. So a cancel issued on replica A reaches a
// job running on replica B via the shared flag — the in-memory abortControllers
// map is only a same-replica fast path, NOT the cross-replica mechanism. This
// pins that contract: aborts driven purely by the shared flag, with no local
// map entry from a same-process cancel call.
//
// The dead child-process SIGTERM path (the only replica-LOCAL cancellation
// mechanism) was removed in this change, so ALL live cancellation now flows
// through the shared flag.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/notifications-host", () => ({}));

// Avoid real Redis / BullMQ connections — registerBackgroundJobAbortController
// only needs the runtime's in-memory Maps, not a live queue.
vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve();
    }
  },
}));
vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    waitUntilReady() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    get qualifiedName() {
      return "bull:cinatra-bg-test";
    }
  },
  Worker: class FakeWorker {
    on() {
      return this;
    }
    waitUntilReady() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  },
  DelayedError: class DelayedError extends Error {},
}));

// The SHARED metadata store, standing in for the single Postgres `metadata`
// table every replica reads/writes. Setting a value here models replica A's
// cancel landing in shared storage; the code under test reads it as replica B.
const CANCELLATION_KEY = "background_job_cancellation_requests";
let metaStore: Record<string, unknown> = {};
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: (key: string, fallback: unknown) =>
    key in metaStore ? metaStore[key] : fallback,
  writeMetadataValueToDatabase: (key: string, value: unknown) => {
    metaStore[key] = value;
  },
}));

import {
  registerBackgroundJobAbortController,
  unregisterBackgroundJobAbortController,
} from "@/lib/background-jobs";

// `globalThis.__cinatraBackgroundJobRuntime` is ambient-declared by
// src/lib/background-jobs.ts (imported above); reset it per test for a fresh
// runtime (fresh in-memory Maps).

beforeEach(() => {
  metaStore = {};
  // Fresh runtime (fresh in-memory Maps) per test.
  globalThis.__cinatraBackgroundJobRuntime = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cross-replica cancellation via the shared flag (cinatra#849)", () => {
  it("aborts immediately when another replica already set the shared cancellation flag", () => {
    // Replica A's cancel already persisted to shared Postgres before this
    // replica registers the running job's controller.
    metaStore[CANCELLATION_KEY] = { "job-1": true };

    const controller = new AbortController();
    registerBackgroundJobAbortController("job-1", controller);

    // No same-process cancel call touched this runtime's in-memory map — the
    // abort came purely from reading the shared flag.
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts via the 750ms poller when the shared flag is set AFTER registration", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    registerBackgroundJobAbortController("job-2", controller);
    expect(controller.signal.aborted).toBe(false);

    // Replica A issues the cancel now (writes the shared flag).
    metaStore[CANCELLATION_KEY] = { "job-2": true };

    // Before a poll tick, this replica has not yet seen it.
    expect(controller.signal.aborted).toBe(false);

    // One poll interval later, the shared flag drives the local abort.
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.signal.aborted).toBe(true);

    unregisterBackgroundJobAbortController("job-2");
  });

  it("does not abort while the shared flag stays unset", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    registerBackgroundJobAbortController("job-3", controller);

    await vi.advanceTimersByTimeAsync(3_000); // several poll intervals
    expect(controller.signal.aborted).toBe(false);

    unregisterBackgroundJobAbortController("job-3");
  });
});
