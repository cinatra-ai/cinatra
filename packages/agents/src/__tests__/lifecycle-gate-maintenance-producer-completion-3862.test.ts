import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3862 leg 7 (slice 2) — the review maintenance sweep completes every
// repair through the generic completer alone: the CMS bridge's completion step
// and its three counters are gone. Every collaborator of the sweep is replaced:
// the database answers every read and write with an empty list, the earlier
// steps find nothing to do, and the generic completer only records that it ran
// (in a shared order list) and answers fixed counts. The CMS bridge is mocked
// only as a witness: loading it records "cms". The dispatch step, the one road
// that still loads the bridge, is mocked above, so only a completion step could
// load it here. No database.
//
// The sweep is imported INSIDE the case; the mocks are registered per case
// (vi.doMock) and removed after it (vi.doUnmock + resetModules), so nothing this
// file mocks leaks into another file of the package's run.

const order: string[] = [];

const MOCKED = [
  "server-only",
  "../db",
  "@/lib/lifecycle/lifecycle-activation",
  "../lifecycle-continuation-park-store",
  "../lifecycle-repair-dispatch-store",
  "../lifecycle-repair-cms-production-bridge",
  "../lifecycle-repair-producer-completion-store",
] as const;

/** A query-builder chain whose every step returns itself and which resolves to
 * an empty list when awaited, whatever step it ends on. */
function emptyChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const step of [
    "from", "where", "orderBy", "limit", "innerJoin", "leftJoin", "groupBy",
    "set", "values", "returning", "onConflictDoNothing", "onConflictDoUpdate",
  ]) {
    chain[step] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve([] as unknown[]).then(resolve, reject);
  return chain;
}

beforeEach(() => {
  order.length = 0;
  vi.doMock("server-only", () => ({}));
  vi.doMock("../db", () => ({
    db: {
      select: () => emptyChain(),
      update: () => emptyChain(),
      insert: () => emptyChain(),
    },
    agentBuilderPool: {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    },
  }));
  vi.doMock("@/lib/lifecycle/lifecycle-activation", () => ({
    isLifecycleReviewOrchestrationActive: () => true,
  }));
  vi.doMock("../lifecycle-continuation-park-store", () => ({
    sweepParks: async () => ({ released: 0, blocked: 0 }),
    maybeParkCheckpoint: async () => undefined,
  }));
  vi.doMock("../lifecycle-repair-dispatch-store", () => ({
    dispatchPendingProducerRepairs: async () => ({ dispatched: 0, escalated: 0 }),
    repairIdFromRunId: () => null,
  }));
  vi.doMock("../lifecycle-repair-cms-production-bridge", () => {
    order.push("cms");
    return {
      completeDispatchedProducerCmsRepairs: async () => ({ completed: 0, unresolved: 0, repairedCaptureMissing: 0 }),
    };
  });
  vi.doMock("../lifecycle-repair-producer-completion-store", () => ({
    completeDispatchedProducerRepairs: async () => {
      order.push("generic");
      return { completed: 2, unresolved: 1 };
    },
  }));
});

afterEach(() => {
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cinatra#3862 leg 7 — the maintenance sweep completes repairs through the generic completer only", () => {
  it("runs the generic completer, never the CMS bridge, and its summary has no CMS repair counters", async () => {
    const { sweepLifecycleGateMaintenance } = await import("../lifecycle-review-orchestration-store");
    const summary = await sweepLifecycleGateMaintenance();

    expect(order).toEqual(["generic"]);
    expect(summary.producerRepairsCompleted).toBe(2);
    expect(summary.producerRepairsUnresolved).toBe(1);
    expect(Object.keys(summary).filter((key) => /cms/i.test(key))).toEqual([]);
  });
});
