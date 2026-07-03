// The EXTENSION_STORE_GC_REAP recurring job (cinatra#796): the handler
// resolves the reaper through the BOOT-REGISTERED slot (route-graph ratchet:
// the handler registry is in the locked routes' reachable graph, so it must
// not carry an import specifier for the maintenance-only reaper). Covered:
//   - empty slot → loud no-op cycle that still RE-DELAYS (the loop never dies);
//   - registered runner → invoked exactly once, cycle re-delays.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelayedError } from "bullmq";

vi.mock("server-only", () => ({}));

const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/errors/server", () => ({
  captureBackgroundJobError: captureMock,
}));

import { registerExtensionStoreReaper } from "@/lib/background-jobs-registry";
import {
  BACKGROUND_JOB_NAMES,
  EXTENSION_STORE_GC_REAP_LOOP_JOB_ID,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";
import type { ExtensionStoreReapReport } from "@/lib/extension-store-reaper";

function makeReapJob(moveToDelayed: ReturnType<typeof vi.fn>) {
  return {
    name: BACKGROUND_JOB_NAMES.EXTENSION_STORE_GC_REAP,
    data: {},
    id: EXTENSION_STORE_GC_REAP_LOOP_JOB_ID, // canonical loop id → re-delay path
    queueName: "cinatra-bg-test",
    token: "test-token",
    moveToDelayed,
  } as unknown as Parameters<typeof dispatchBackgroundJob>[0];
}

function emptyReport(): ExtensionStoreReapReport {
  return {
    dryRun: false,
    dataRoot: "/root",
    scannedDigests: 0,
    activeDigests: 0,
    unsafeSlugs: [],
    deleted: [],
    retained: [],
    protectedEntries: [],
    skippedForRacedLease: [],
    skippedForRacedActive: [],
    failedDeletes: [],
  };
}

beforeEach(() => {
  captureMock.mockClear();
  // Reset the globalThis-backed slot between tests.
  (globalThis as { __cinatraExtensionStoreReaperRunner?: unknown }).__cinatraExtensionStoreReaperRunner =
    undefined;
});

describe("EXTENSION_STORE_GC_REAP job — boot-registered reaper slot", () => {
  it("empty slot → warns + skips the cycle but STILL re-delays (loop never dies)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeReapJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no reaper registered"))).toBe(true);
    expect(captureMock).not.toHaveBeenCalled(); // a skipped cycle is not an error
    warn.mockRestore();
  });

  it("registered runner → invoked once; cycle logs the summary and re-delays", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = vi.fn(async () => emptyReport());
    registerExtensionStoreReaper(runner);
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeReapJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes("[extension-store-gc-reap]"))).toBe(
      true,
    );
    log.mockRestore();
  });

  it("a throwing reaper cycle is reported + the loop still re-delays (runRecurringLoop policy)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerExtensionStoreReaper(async () => {
      throw new Error("reap boom");
    });
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeReapJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    error.mockRestore();
  });
});
