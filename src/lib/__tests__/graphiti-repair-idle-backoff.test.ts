// cinatra#2582 — the GRAPHITI_PROJECTION_REPAIR projection work backs off when
// the outbox is idle, WITHOUT touching the two other duties on the same loop.
//
// The projection cycle ran every 30s unconditionally: 4,248 runs on the
// reported install, each against an empty outbox, and on a keyed instance the
// continuous driver of Graphiti's OpenAI fan-out. The owner's ruling attaches a
// hard constraint to fixing that: the SAME loop drains the binding-reconcile
// queue and re-runs `ensureCrmSyncRegistrations`, and the backoff must keep
// those live.
//
// So the LOOP cadence is deliberately untouched (30s, asserted below) and the
// PROJECTION CYCLE is what gets skipped while idle. This file is the proof of
// both halves: the projection work thins out, and the other two duties run on
// every single cycle with byte-identical latency.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DelayedError } from "bullmq";

vi.mock("server-only", () => ({}));

const { ensureCrmSyncRegistrations, resolveCrmPointerWriter } = vi.hoisted(() => ({
  ensureCrmSyncRegistrations: vi.fn(),
  resolveCrmPointerWriter: vi.fn(() => null),
}));
vi.mock("@/lib/crm-integration-providers", () => ({
  ensureCrmSyncRegistrations,
  resolveCrmPointerWriter,
}));

const { processBindingReconcileQueue } = vi.hoisted(() => ({
  processBindingReconcileQueue: vi.fn(() => ({ processed: 0, failed: 0 })),
}));
vi.mock("@/lib/objects/binding-reconcile-sweep", () => ({
  processBindingReconcileQueue,
}));

const { processGraphitiProjectionCycle } = vi.hoisted(() => ({
  processGraphitiProjectionCycle: vi.fn(async () => ({
    processed: 0,
    failed: 0,
    epochBumps: 0,
    journalsAdvanced: 0,
    journalsOpen: 0,
  })),
}));
vi.mock("@cinatra-ai/objects/graphiti-rebuild", () => ({
  processGraphitiProjectionCycle,
}));

vi.mock("@cinatra-ai/errors/server", () => ({
  captureBackgroundJobError: vi.fn(async () => {}),
}));

import {
  GRAPHITI_REPAIR_BASE_DELAY_MS,
  GRAPHITI_PROJECTION_MAX_INTERVAL_CYCLES,
  GRAPHITI_REPAIR_IDLE_GRACE_CYCLES,
  graphitiProjectionIntervalCycles,
  shouldRunGraphitiProjectionCycle,
  isGraphitiRepairCycleIdle,
  __resetGraphitiRepairBackoffForTests,
} from "@/lib/background-jobs-registry";
import {
  BACKGROUND_JOB_NAMES,
  GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";

const NOW = new Date("2026-08-09T12:00:00.000Z").getTime();

const IDLE_CYCLE = {
  processed: 0,
  failed: 0,
  epochBumps: 0,
  journalsAdvanced: 0,
  journalsOpen: 0,
};

const moveToDelayed = vi.fn<(runAtMs: number, token?: string) => Promise<void>>();

function loopJob() {
  return {
    name: BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR,
    data: {},
    id: GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
    queueName: "cinatra-bg-test",
    token: "test-token",
    moveToDelayed,
  } as unknown as Parameters<typeof dispatchBackgroundJob>[0];
}

/** Run one loop cycle; return the delay it scheduled for the next one. */
async function runCycle(): Promise<number> {
  moveToDelayed.mockClear();
  await expect(dispatchBackgroundJob(loopJob())).rejects.toBeInstanceOf(DelayedError);
  expect(moveToDelayed).toHaveBeenCalledTimes(1);
  return moveToDelayed.mock.calls[0]![0] - NOW;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetGraphitiRepairBackoffForTests();
  moveToDelayed.mockReset().mockResolvedValue(undefined);
  ensureCrmSyncRegistrations.mockClear();
  processBindingReconcileQueue.mockReset().mockReturnValue({ processed: 0, failed: 0 });
  processGraphitiProjectionCycle.mockReset().mockResolvedValue({ ...IDLE_CYCLE });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the idle-interval curve (pure)", () => {
  it("holds every-cycle projection through the grace window, then doubles to a ceiling", () => {
    for (let streak = 0; streak <= GRAPHITI_REPAIR_IDLE_GRACE_CYCLES; streak += 1) {
      expect(graphitiProjectionIntervalCycles(streak)).toBe(1);
    }
    const g = GRAPHITI_REPAIR_IDLE_GRACE_CYCLES;
    expect(graphitiProjectionIntervalCycles(g + 1)).toBe(2);
    expect(graphitiProjectionIntervalCycles(g + 2)).toBe(4);
    expect(graphitiProjectionIntervalCycles(g + 3)).toBe(8);
    // …and never past the ceiling, however long the instance stays quiet.
    expect(graphitiProjectionIntervalCycles(g + 99)).toBe(
      GRAPHITI_PROJECTION_MAX_INTERVAL_CYCLES,
    );
  });

  it("runs the projection immediately when the reconcile drain did work", () => {
    // The drain happens first precisely so freshly reconciled bindings project
    // in the SAME cycle — a backoff must not break that contract.
    expect(
      shouldRunGraphitiProjectionCycle({
        idleStreak: 99,
        cyclesSinceRun: 1,
        reconciledWork: true,
      }),
    ).toBe(true);
    expect(
      shouldRunGraphitiProjectionCycle({
        idleStreak: 99,
        cyclesSinceRun: 1,
        reconciledWork: false,
      }),
    ).toBe(false);
  });

  it("counts reconcile work and an OPEN rebuild journal as work", () => {
    expect(isGraphitiRepairCycleIdle({ processed: 0, failed: 0 }, IDLE_CYCLE)).toBe(true);
    expect(isGraphitiRepairCycleIdle({ processed: 1, failed: 0 }, IDLE_CYCLE)).toBe(false);
    expect(isGraphitiRepairCycleIdle({ processed: 0, failed: 1 }, IDLE_CYCLE)).toBe(false);
    expect(
      isGraphitiRepairCycleIdle({ processed: 0, failed: 0 }, { ...IDLE_CYCLE, journalsOpen: 1 }),
    ).toBe(false);
  });
});

describe("the LOOP cadence never moves — that is what protects the other duties", () => {
  it("re-delays at exactly 30s on every cycle, idle or not", async () => {
    for (let i = 0; i < GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 8; i += 1) {
      expect(await runCycle()).toBe(GRAPHITI_REPAIR_BASE_DELAY_MS);
    }
  });

  it("re-registers CRM sync and drains the reconcile queue on EVERY cycle", async () => {
    const cycles = GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 8;
    for (let i = 0; i < cycles; i += 1) await runCycle();

    // Not "most cycles", not "the hot ones" — every single one, including the
    // ones whose projection work was skipped.
    expect(ensureCrmSyncRegistrations).toHaveBeenCalledTimes(cycles);
    expect(processBindingReconcileQueue).toHaveBeenCalledTimes(cycles);
    // …and the projection work did NOT run on all of them.
    expect(processGraphitiProjectionCycle.mock.calls.length).toBeLessThan(cycles);
  });

  it("keeps the reconcile drain BEFORE the projection cycle", async () => {
    const order: string[] = [];
    processBindingReconcileQueue.mockImplementation(() => {
      order.push("reconcile");
      return { processed: 0, failed: 0 };
    });
    processGraphitiProjectionCycle.mockImplementation(async () => {
      order.push("projection");
      return { ...IDLE_CYCLE };
    });
    ensureCrmSyncRegistrations.mockImplementation(() => {
      order.push("crm-registrations");
    });

    await runCycle();
    expect(order).toEqual(["crm-registrations", "reconcile", "projection"]);
  });
});

describe("the projection work thins out only while the outbox is provably idle", () => {
  it("runs every cycle through the grace window, then every 2nd, 4th, 8th…", async () => {
    const g = GRAPHITI_REPAIR_IDLE_GRACE_CYCLES;
    for (let i = 0; i < g + 1; i += 1) await runCycle();
    // Grace window: one projection per cycle, exactly as before this change.
    expect(processGraphitiProjectionCycle).toHaveBeenCalledTimes(g + 1);

    // Interval is now 2: the next cycle skips, the one after runs.
    await runCycle();
    expect(processGraphitiProjectionCycle).toHaveBeenCalledTimes(g + 1);
    await runCycle();
    expect(processGraphitiProjectionCycle).toHaveBeenCalledTimes(g + 2);
  });

  it("caps the skipping, so an idle instance still sweeps its outbox regularly", async () => {
    for (let i = 0; i < 60; i += 1) await runCycle();
    const runs = processGraphitiProjectionCycle.mock.calls.length;
    // With the ceiling at 10 cycles (5 minutes), an hour of idling still sweeps.
    expect(runs).toBeGreaterThanOrEqual(60 / GRAPHITI_PROJECTION_MAX_INTERVAL_CYCLES);
  });

  it("snaps back to every-cycle the moment the OUTBOX has work", async () => {
    for (let i = 0; i < GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 6; i += 1) await runCycle();
    processGraphitiProjectionCycle.mockResolvedValueOnce({ ...IDLE_CYCLE, processed: 3 });

    // Drive cycles until the backed-off projection actually runs and reports work.
    let before = processGraphitiProjectionCycle.mock.calls.length;
    while (processGraphitiProjectionCycle.mock.calls.length === before) await runCycle();

    // From here the projection is due again on the very next cycle.
    before = processGraphitiProjectionCycle.mock.calls.length;
    await runCycle();
    expect(processGraphitiProjectionCycle.mock.calls.length).toBe(before + 1);
  });

  it("runs the projection IMMEDIATELY when reconcile work lands mid-backoff", async () => {
    for (let i = 0; i < GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 6; i += 1) await runCycle();
    const before = processGraphitiProjectionCycle.mock.calls.length;

    // The constraint in one assertion: a claim reconciliation is served at full
    // speed and projects in the same cycle, however long the outbox was idle.
    processBindingReconcileQueue.mockReturnValueOnce({ processed: 2, failed: 0 });
    await runCycle();
    expect(processGraphitiProjectionCycle.mock.calls.length).toBe(before + 1);
  });

  it("a FAILING projection cycle is retried on the very next cycle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Enter a genuinely BACKED-OFF state first — that is where the hazard is:
    // if the due counter were reset before the cycle ran, a throw would consume
    // its own slot and the retry would wait the full backed-off gap.
    for (let i = 0; i < GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 6; i += 1) await runCycle();
    expect(graphitiProjectionIntervalCycles(GRAPHITI_REPAIR_IDLE_GRACE_CYCLES + 6)).toBeGreaterThan(
      1,
    );

    // Drive cycles until the backed-off projection is due, and make it throw.
    const before = processGraphitiProjectionCycle.mock.calls.length;
    processGraphitiProjectionCycle.mockRejectedValueOnce(new Error("outbox boom"));
    while (processGraphitiProjectionCycle.mock.calls.length === before) await runCycle();

    // The very next cycle attempts it again — an erroring instance is the last
    // one that should be visited less often — and while it keeps failing it is
    // attempted on EVERY cycle, because a throw never counts as a completed
    // (and therefore idle) cycle.
    processGraphitiProjectionCycle.mockRejectedValue(new Error("outbox boom"));
    for (let i = 0; i < 5; i += 1) {
      const attempts = processGraphitiProjectionCycle.mock.calls.length;
      expect(await runCycle()).toBe(GRAPHITI_REPAIR_BASE_DELAY_MS);
      expect(processGraphitiProjectionCycle.mock.calls.length).toBe(attempts + 1);
    }
    error.mockRestore();
  });
});
