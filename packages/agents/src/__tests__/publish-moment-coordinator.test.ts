/**
 * THE PUBLISH MOMENT IN THE COORDINATOR (cinatra#4150 part 7a-2).
 *
 * The run states the publish moment when the 3a park holds it at a publish gate, with the publish card as its card
 * kind and the decision's id as its card reference, pinned to the park's status. The moment ends when a decline or an
 * expiry stops the run, or a Publish releases it: the clear takes off only the publish moment, and only while the run
 * is in the status the caller just won. The park's write also holds only while its decision is still parked, in the
 * same statement, so a released or superseded decision is never stated as the current moment. Both entries throw
 * their failures to the publish road, which logs them by a fixed error name; the coordinator logs neither the run id
 * nor the store's text. The publish moment feeds the run outbox like the HITL screen's (part 7b): the host writer adds no
 * part for this interrupt kind, because every host, the site widget among them, mounts the card from the run's own state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordRunLifecycleMoment = vi.fn(async (..._args: unknown[]) => undefined);
const readAgentRunById = vi.fn(async (..._args: unknown[]) => null as unknown);

vi.mock("../store", () => ({
  createAgentRun: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...a),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code = "stale_from_status";
  },
}));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn(async () => undefined) }));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));

import * as coordinator from "../lifecycle-coordinator";
import {
  LIFECYCLE_OUTBOX_BUDGET_MS,
  momentFeedsRunOutbox,
  setLifecyclePartOutbox,
  type LifecycleMomentOpened,
} from "../lifecycle-part-outbox";

const RUN = { id: "run-1", orgId: "org-1", status: "pending_approval" } as never;
const AUTHORITY = { orgId: "org-1" } as never;

let opened: LifecycleMomentOpened[] = [];

beforeEach(() => {
  opened = [];
  recordRunLifecycleMoment.mockReset();
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  readAgentRunById.mockReset();
  readAgentRunById.mockResolvedValue(null);
  setLifecyclePartOutbox({
    async onMomentOpened(entry) {
      opened.push(entry);
    },
  });
});

describe("the run stops at a publish gate (A4, the moment half)", () => {
  it("states the publish moment with the publish card and the decision's id, only while the run waits at the gate", async () => {
    const answer = await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
    expect(recordRunLifecycleMoment).toHaveBeenCalledTimes(1);
    expect(recordRunLifecycleMoment).toHaveBeenCalledWith(
      {
        runId: "run-1",
        orgId: "org-1",
        moment: "publish",
        cardKind: "publish_decision",
        cardRef: "dec-1",
        onlyWhileStatus: "pending_approval",
        onlyWhilePublishDecisionParked: "dec-1",
      },
      AUTHORITY,
    );
    expect(answer.moment).toBe("publish");
  });

  it("feeds the run outbox once with the publish card and the decision's id, AFTER the record", async () => {
    const order: string[] = [];
    recordRunLifecycleMoment.mockImplementationOnce(async () => {
      order.push("record");
      return undefined;
    });
    setLifecyclePartOutbox({
      async onMomentOpened(entry) {
        order.push("outbox");
        opened.push(entry);
      },
    });
    await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
    expect(opened).toEqual([
      { runId: "run-1", orgId: "org-1", moment: "publish", cardKind: "publish_decision", cardRef: "dec-1" },
    ]);
    expect(order).toEqual(["record", "outbox"]);
    expect(momentFeedsRunOutbox("publish")).toBe(true);
  });

  it("a writer that stalls synchronously past the budget: the park still answers publish, and the overrun is reported", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setLifecyclePartOutbox({
        onMomentOpened: () => {
          vi.advanceTimersByTime(LIFECYCLE_OUTBOX_BUDGET_MS + 3_000);
          return Promise.resolve();
        },
      });
      const answer = await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
      expect(answer.moment).toBe("publish");
      expect(recordRunLifecycleMoment).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("[lifecycle-part-outbox]"))).toBe(true);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a park whose record fails feeds nothing", async () => {
    recordRunLifecycleMoment.mockRejectedValueOnce(new Error("db failure"));
    await expect(
      coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY }),
    ).rejects.toThrow("db failure");
    expect(opened).toEqual([]);
  });

  it("a record that fails is thrown to the publish road and logged nowhere here: no run id, no store text", async () => {
    recordRunLifecycleMoment.mockRejectedValueOnce(new Error("db failure: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY }),
      ).rejects.toThrow("db failure");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the publish moment ends (A7, A8, A9, the moment halves)", () => {
  it.each([
    ["a decline stopped the run", "stopped", "declined"],
    ["an expiry stopped the run", "stopped", "expired"],
    ["a Publish released the run", "running", "publish_approved"],
  ] as const)("%s: the clear takes off only the publish moment, pinned to the status the caller won", async (_l, whileStatus, why) => {
    await coordinator.clearPublishMoment({ run: RUN, whileStatus, why, authority: AUTHORITY });
    expect(recordRunLifecycleMoment).toHaveBeenCalledTimes(1);
    expect(recordRunLifecycleMoment).toHaveBeenCalledWith(
      { runId: "run-1", orgId: "org-1", moment: null, onlyWhileMoment: "publish", onlyWhileStatus: whileStatus },
      AUTHORITY,
    );
    // No read between the decision and the clear: the guard is the write itself, so a newer moment is never read
    // and then taken off.
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("a clear that fails is thrown to the publish road and logged nowhere here: no run id, no store text", async () => {
    recordRunLifecycleMoment.mockRejectedValueOnce(new Error("db failure: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        coordinator.clearPublishMoment({ run: RUN, whileStatus: "running", why: "publish_approved", authority: AUTHORITY }),
      ).rejects.toThrow("db failure");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// The park's write is guarded by its decision's parked state in the same statement (the real statement is proven on a
// real database in src/lib/__tests__/agent-run-lifecycle-moment.integration.test.ts). This store applies the writer's
// guards as that statement does, to show which decision may still be stated.
describe("a released or superseded decision is never written as the current moment", () => {
  type Row = { status: string; lifecycleMoment: string | null; lifecycleCardRef: string | null };
  let row: Row;
  let decisionStatus: Record<string, string>;

  beforeEach(() => {
    recordRunLifecycleMoment.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as {
        moment: string | null;
        cardRef?: string | null;
        onlyWhileStatus?: string;
        onlyWhileMoment?: string | null;
        onlyWhilePublishDecisionParked?: string;
      };
      if (input.onlyWhileStatus !== undefined && row.status !== input.onlyWhileStatus) return undefined;
      if (input.onlyWhileMoment !== undefined && row.lifecycleMoment !== input.onlyWhileMoment) return undefined;
      const parked = input.onlyWhilePublishDecisionParked;
      if (parked !== undefined && decisionStatus[parked] !== "parked") return undefined;
      row.lifecycleMoment = input.moment;
      row.lifecycleCardRef = input.cardRef ?? null;
      return undefined;
    });
  });

  it("a delayed park write after Publish released the decision and its failed send gave the run back states nothing", async () => {
    // The park committed pending_approval; Publish claimed, released the decision and cleared (no moment yet); the send
    // failed before dispatch and gave the run back to pending_approval. Then the park's moment write arrives.
    row = { status: "pending_approval", lifecycleMoment: null, lifecycleCardRef: null };
    decisionStatus = { "dec-1": "released" };
    await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
    expect(row).toEqual({ status: "pending_approval", lifecycleMoment: null, lifecycleCardRef: null });
  });

  it("a resumed run parked at a newer decision keeps that card when the older park's write arrives late", async () => {
    row = { status: "pending_approval", lifecycleMoment: "publish", lifecycleCardRef: "dec-2" };
    decisionStatus = { "dec-1": "released", "dec-2": "parked" };
    await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
    expect(row).toEqual({ status: "pending_approval", lifecycleMoment: "publish", lifecycleCardRef: "dec-2" });
  });

  it("a decision that is still parked is stated", async () => {
    row = { status: "pending_approval", lifecycleMoment: null, lifecycleCardRef: null };
    decisionStatus = { "dec-1": "parked" };
    await coordinator.onPublishGate({ run: RUN, decisionId: "dec-1", authority: AUTHORITY });
    expect(row).toEqual({ status: "pending_approval", lifecycleMoment: "publish", lifecycleCardRef: "dec-1" });
  });
});
