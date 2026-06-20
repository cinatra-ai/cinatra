import { describe, expect, it, vi } from "vitest";

import {
  runPmScheduleReconcile,
  type PmScheduleReconcileDeps,
  type PmLinkReconcileRow,
  type LocalTriggerSnapshot,
} from "../reconcile-worker";

function link(over: Partial<PmLinkReconcileRow> & { runId: string }): PmLinkReconcileRow {
  return {
    provider: "plane",
    externalTaskId: null,
    syncedAt: null,
    syncError: null,
    version: 0,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

function trigger(over: Partial<LocalTriggerSnapshot> & { runId: string }): LocalTriggerSnapshot {
  return {
    triggerType: "scheduled",
    scheduledAt: new Date("2026-06-02T09:30:00Z"),
    cronExpression: null,
    timezone: "UTC",
    enabled: true,
    updatedAt: new Date("2026-06-01T12:00:00Z"),
    ...over,
  };
}

/** Build deps from a single page of rows + a trigger map; spies on the bridge fns. */
function makeDeps(
  rows: PmLinkReconcileRow[],
  triggersByRunId: Record<string, LocalTriggerSnapshot | null>,
  overrides: Partial<PmScheduleReconcileDeps> = {},
): PmScheduleReconcileDeps {
  return {
    // Default: one full page (keyset-aware so a second call returns []).
    listLinksNeedingReconcile: vi.fn(async ({ afterRunId, limit }) => {
      const start = afterRunId
        ? rows.findIndex((r) => r.runId === afterRunId) + 1
        : 0;
      return rows.slice(start, start + limit);
    }),
    readLocalTrigger: vi.fn(async (runId: string) =>
      runId in triggersByRunId ? triggersByRunId[runId] : null,
    ),
    syncTrigger: vi.fn(async () => {}),
    deleteTrigger: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runPmScheduleReconcile — outbound-repair decision matrix", () => {
  it("re-pushes when the local trigger EXISTS (existence + enabled re-projection)", async () => {
    const rows = [link({ runId: "r1", syncError: "boom" })];
    const t = trigger({ runId: "r1", enabled: false, cronExpression: "0 9 * * *", scheduledAt: null });
    const deps = makeDeps(rows, { r1: t });

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 1, repaired: 1, skipped: 0, failed: 0 });
    expect(deps.syncTrigger).toHaveBeenCalledTimes(1);
    expect(deps.syncTrigger).toHaveBeenCalledWith({
      runId: "r1",
      triggerType: "scheduled",
      scheduledAt: null,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: false, // paused flag re-projected outward
    });
    expect(deps.deleteTrigger).not.toHaveBeenCalled();
  });

  it("serializes scheduledAt to an ISO-8601 string for the bridge", async () => {
    const rows = [link({ runId: "r1", externalTaskId: null })];
    const t = trigger({ runId: "r1", scheduledAt: new Date("2026-06-02T09:30:00Z") });
    const deps = makeDeps(rows, { r1: t });

    await runPmScheduleReconcile(deps);

    expect(deps.syncTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: "2026-06-02T09:30:00.000Z" }),
    );
  });

  it("finishes a DEFERRED DELETE when the trigger is GONE but a task id remains", async () => {
    const rows = [link({ runId: "r1", externalTaskId: "task-123", syncError: "provider down" })];
    const deps = makeDeps(rows, { r1: null });

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 1, repaired: 1, skipped: 0, failed: 0 });
    expect(deps.deleteTrigger).toHaveBeenCalledExactlyOnceWith({ runId: "r1" });
    expect(deps.syncTrigger).not.toHaveBeenCalled();
  });

  it("leaves an UNKNOWN-UPSTREAM row STICKY (trigger gone, no task id, has error)", async () => {
    const rows = [link({ runId: "r1", externalTaskId: null, syncError: "timed out" })];
    const deps = makeDeps(rows, { r1: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 1, repaired: 0, skipped: 1, failed: 0 });
    expect(deps.syncTrigger).not.toHaveBeenCalled();
    expect(deps.deleteTrigger).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sticky"));
    warn.mockRestore();
  });

  it("routes a PROVABLY-CLEAN row through deleteTrigger (trigger gone, no task id, NO error)", async () => {
    // No external_task_id AND no sync_error: nothing was ever pushed, so there
    // is no upstream task to orphan. The host bridge `deleteTrigger` drops the
    // provably-clean row — we must not leave it sticky forever.
    const rows = [link({ runId: "r1", externalTaskId: null, syncError: null })];
    const deps = makeDeps(rows, { r1: null });

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 1, repaired: 1, skipped: 0, failed: 0 });
    expect(deps.deleteTrigger).toHaveBeenCalledExactlyOnceWith({ runId: "r1" });
    expect(deps.syncTrigger).not.toHaveBeenCalled();
  });
});

describe("runPmScheduleReconcile — never throws, counts failures", () => {
  it("counts a per-row syncTrigger throw as failed and continues the sweep", async () => {
    const rows = [
      link({ runId: "r1", syncError: "boom" }),
      link({ runId: "r2", syncError: "boom" }),
    ];
    const deps = makeDeps(rows, { r1: trigger({ runId: "r1" }), r2: trigger({ runId: "r2" }) });
    (deps.syncTrigger as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("provider exploded"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 2, repaired: 1, skipped: 0, failed: 1 });
    expect(deps.syncTrigger).toHaveBeenCalledTimes(2); // r2 still attempted after r1 threw
    warn.mockRestore();
  });

  it("ends the sweep cleanly (no throw) when the enumerator itself throws", async () => {
    const deps = makeDeps([], {});
    (deps.listLinksNeedingReconcile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db blip"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 0, repaired: 0, skipped: 0, failed: 0 });
    warn.mockRestore();
  });

  it("counts a readLocalTrigger throw as a per-row failure, not a sweep abort", async () => {
    const rows = [link({ runId: "r1", syncError: "x" }), link({ runId: "r2", syncError: "x" })];
    const deps = makeDeps(rows, { r2: trigger({ runId: "r2" }) });
    (deps.readLocalTrigger as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("read failed")) // r1
      .mockResolvedValueOnce(trigger({ runId: "r2" })); // r2
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 2, failed: 1, repaired: 1 });
    warn.mockRestore();
  });
});

describe("runPmScheduleReconcile — keyset pagination", () => {
  it("pages with the keyset cursor and stops on a short page", async () => {
    const rows = [
      link({ runId: "a", syncError: "x" }),
      link({ runId: "b", syncError: "x" }),
      link({ runId: "c", syncError: "x" }),
    ];
    const deps = makeDeps(rows, {
      a: trigger({ runId: "a" }),
      b: trigger({ runId: "b" }),
      c: trigger({ runId: "c" }),
    });

    const summary = await runPmScheduleReconcile(deps, { pageSize: 2 });

    expect(summary).toMatchObject({ attempted: 3, repaired: 3 });
    // page1 (a,b) full → page2 (c) short → stop. Exactly 2 enumerator calls.
    expect(deps.listLinksNeedingReconcile).toHaveBeenCalledTimes(2);
    expect(deps.listLinksNeedingReconcile).toHaveBeenNthCalledWith(1, {
      afterRunId: undefined,
      limit: 2,
    });
    expect(deps.listLinksNeedingReconcile).toHaveBeenNthCalledWith(2, {
      afterRunId: "b",
      limit: 2,
    });
  });

  it("pages to completion (no per-sweep cap) so EVERY candidate is reached", async () => {
    // 10 candidates; with pageSize 4 that is 3 pages (4+4+2). Every row must be
    // examined in a single sweep — there is deliberately no per-sweep row cap
    // (a head-restarting cap would starve later rows when early rows stay
    // sticky/failing).
    const rows = Array.from({ length: 10 }, (_, i) =>
      link({ runId: `r${i.toString().padStart(2, "0")}`, syncError: "x" }),
    );
    const triggers = Object.fromEntries(rows.map((r) => [r.runId, trigger({ runId: r.runId })]));
    const deps = makeDeps(rows, triggers);

    const summary = await runPmScheduleReconcile(deps, { pageSize: 4 });

    expect(summary.attempted).toBe(10);
    expect(summary.repaired).toBe(10);
    expect(deps.listLinksNeedingReconcile).toHaveBeenCalledTimes(3); // 4 + 4 + 2(short)
  });

  it("reaches LATER rows even when EARLY rows stay sticky across the sweep", async () => {
    // Fairness regression guard for the removed per-sweep cap: many early rows
    // are sticky (unknown-upstream), but a later row must still be processed in
    // the same sweep — the keyset cursor advances PAST sticky rows.
    const stickyEarly = Array.from({ length: 8 }, (_, i) =>
      link({ runId: `a${i}`, externalTaskId: null, syncError: "timed out" }),
    );
    const laterLive = link({ runId: "z-last", syncError: "x" });
    const rows = [...stickyEarly, laterLive];
    const deps = makeDeps(rows, { "z-last": trigger({ runId: "z-last" }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps, { pageSize: 3 });

    expect(summary.attempted).toBe(9);
    expect(summary.skipped).toBe(8); // the sticky early rows
    expect(summary.repaired).toBe(1); // the later live row WAS reached + re-pushed
    expect(deps.syncTrigger).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "z-last" }),
    );
    warn.mockRestore();
  });

  it("is silent and a clean no-op when nothing needs reconciling", async () => {
    const deps = makeDeps([], {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const summary = await runPmScheduleReconcile(deps);

    expect(summary).toMatchObject({ attempted: 0, repaired: 0, skipped: 0, failed: 0 });
    expect(log).not.toHaveBeenCalled(); // worker does not log; handler owns the summary line
    log.mockRestore();
  });
});
