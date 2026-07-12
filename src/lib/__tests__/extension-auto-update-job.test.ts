// The EXTENSION_AUTO_UPDATE recurring job (cinatra#1042): the handler
// resolves the cycle through the BOOT-REGISTERED slot (route-graph ratchet:
// the handler registry is in the locked routes' reachable graph, so it must
// not carry an import specifier for the update machinery). Covered:
//   - empty slot → loud no-op cycle that still RE-DELAYS (the loop never dies);
//   - registered runner → invoked exactly once, summary logged, cycle re-delays;
//   - runner reporting the flag off → skipped-cycle log, still re-delays.
// Mirrors extension-store-gc-reap-job.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelayedError } from "bullmq";

vi.mock("server-only", () => ({}));

const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/errors/server", () => ({
  captureBackgroundJobError: captureMock,
}));

import { registerExtensionAutoUpdateRunner } from "@/lib/background-jobs-registry";
import {
  BACKGROUND_JOB_NAMES,
  EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";
import type { ExtensionAutoUpdateRunSummary } from "@/lib/extension-auto-update";

function makeAutoUpdateJob(moveToDelayed: ReturnType<typeof vi.fn>) {
  return {
    name: BACKGROUND_JOB_NAMES.EXTENSION_AUTO_UPDATE,
    data: {},
    id: EXTENSION_AUTO_UPDATE_LOOP_JOB_ID, // canonical loop id → re-delay path
    queueName: "cinatra-bg-test",
    token: "test-token",
    moveToDelayed,
  } as unknown as Parameters<typeof dispatchBackgroundJob>[0];
}

function emptySummary(overrides: Partial<ExtensionAutoUpdateRunSummary> = {}): ExtensionAutoUpdateRunSummary {
  return {
    enabled: true,
    readModelWired: false,
    maintenanceWindowOpen: null,
    signatureReady: null,
    scanned: 0,
    applied: [],
    failed: [],
    skipped: [],
    auditWriteFailures: 0,
    ...overrides,
  };
}

beforeEach(() => {
  captureMock.mockClear();
  // Reset the globalThis-backed slot between tests.
  (globalThis as { __cinatraExtensionAutoUpdateRunner?: unknown }).__cinatraExtensionAutoUpdateRunner =
    undefined;
});

describe("EXTENSION_AUTO_UPDATE job — boot-registered runner slot", () => {
  it("empty slot → warns + skips the cycle but STILL re-delays (loop never dies)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeAutoUpdateJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no runner registered"))).toBe(true);
    expect(captureMock).not.toHaveBeenCalled(); // a skipped cycle is not an error
    warn.mockRestore();
  });

  it("registered runner → invoked once; cycle logs the summary and re-delays", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = vi.fn(async () => emptySummary({ readModelWired: true }));
    registerExtensionAutoUpdateRunner(runner);
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeAutoUpdateJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(
      log.mock.calls.some(
        (c) =>
          String(c[0]).includes("[extension-auto-update]") &&
          String(c[0]).includes("readModelWired=true"),
      ),
    ).toBe(true);
    expect(captureMock).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("runner reporting the master flag OFF → skipped-cycle log, still re-delays", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    registerExtensionAutoUpdateRunner(async () => emptySummary({ enabled: false }));
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeAutoUpdateJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(
      log.mock.calls.some((c) => String(c[0]).includes("master flag disabled at cycle time")),
    ).toBe(true);
    log.mockRestore();
  });

  it("a throwing cycle is reported and the loop still re-delays (cinatra#849)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerExtensionAutoUpdateRunner(async () => {
      throw new Error("install-row read failed");
    });
    const moveToDelayed = vi.fn(async () => {});

    await expect(dispatchBackgroundJob(makeAutoUpdateJob(moveToDelayed))).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    error.mockRestore();
  });
});
