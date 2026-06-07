import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  TransitionError,
  rollUpWorkflowStatus,
  isTerminalTaskStatus,
  deriveEffectiveGateState,
  isDispatchable,
  type GateEntry,
} from "../state";

describe("transition matrices", () => {
  it("allows legal task transitions and rejects illegal ones", () => {
    expect(canTransition("task", "idle", "scheduled")).toBe(true);
    expect(canTransition("task", "scheduled", "running")).toBe(true);
    expect(canTransition("task", "running", "succeeded")).toBe(true);
    expect(canTransition("task", "failed", "scheduled")).toBe(true); // retry
    expect(canTransition("task", "succeeded", "running")).toBe(false); // terminal
    expect(canTransition("task", "idle", "succeeded")).toBe(false); // skips states
  });

  it("treats a same-status re-write as idempotent", () => {
    expect(canTransition("task", "running", "running")).toBe(true);
  });

  it("enforces workflow lifecycle transitions", () => {
    expect(canTransition("workflow", "draft", "active")).toBe(true);
    expect(canTransition("workflow", "active", "paused")).toBe(true);
    expect(canTransition("workflow", "paused", "active")).toBe(true);
    expect(canTransition("workflow", "completed", "active")).toBe(false);
    expect(canTransition("workflow", "draft", "completed")).toBe(false);
  });

  it("enforces attempt + approval transitions", () => {
    expect(canTransition("attempt", "pending", "running")).toBe(true);
    expect(canTransition("attempt", "succeeded", "running")).toBe(false);
    expect(canTransition("approval", "pending", "granted")).toBe(true);
    expect(canTransition("approval", "rejected", "needs_revision")).toBe(true);
    expect(canTransition("approval", "granted", "needs_revision")).toBe(true); // staleness
    expect(canTransition("approval", "granted", "pending")).toBe(false);
  });

  it("assertTransition throws a structured TransitionError on an illegal move", () => {
    expect(() => assertTransition("task", "succeeded", "running")).toThrowError(TransitionError);
    try {
      assertTransition("workflow", "completed", "active");
    } catch (e) {
      expect((e as TransitionError).code).toBe("ILLEGAL_TRANSITION");
      expect((e as TransitionError).kind).toBe("workflow");
    }
  });
});

describe("workflow terminal roll-up", () => {
  it("is active while any task is not terminal", () => {
    expect(rollUpWorkflowStatus([{ status: "succeeded" }, { status: "running" }])).toBe("active");
  });

  it("completes when all tasks are terminal and no blocking failure", () => {
    expect(rollUpWorkflowStatus([{ status: "succeeded" }, { status: "skipped" }])).toBe("completed");
  });

  it("fails when a required task fails with the default block policy", () => {
    expect(rollUpWorkflowStatus([{ status: "succeeded" }, { status: "failed" }])).toBe("failed");
  });

  it("does not fail on an optional or skip-policy failure", () => {
    expect(rollUpWorkflowStatus([{ status: "succeeded" }, { status: "failed", required: false }])).toBe(
      "completed",
    );
    expect(
      rollUpWorkflowStatus([{ status: "succeeded" }, { status: "failed", failurePolicy: "skip" }]),
    ).toBe("completed");
  });

  it("classifies terminal task statuses", () => {
    expect(isTerminalTaskStatus("succeeded")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
  });
});

describe("gate ledger derivation", () => {
  const all = (s: GateEntry["state"]): GateEntry[] => [
    { kind: "timing", state: s },
    { kind: "dependency", state: s },
    { kind: "approval", state: s },
  ];

  it("is dispatchable only when all gates pass", () => {
    expect(isDispatchable(all("passed"))).toBe(true);
    expect(deriveEffectiveGateState(all("passed")).state).toBe("dispatchable");
  });

  it("is pending_approval when timing+deps pass but approval is pending", () => {
    const ledger: GateEntry[] = [
      { kind: "timing", state: "passed" },
      { kind: "dependency", state: "passed" },
      { kind: "approval", state: "pending", reason: "Awaiting Legal sign-off" },
    ];
    const ev = deriveEffectiveGateState(ledger);
    expect(ev.state).toBe("pending_approval");
    expect(ev.blockers[0]).toMatchObject({ kind: "approval", reason: "Awaiting Legal sign-off" });
  });

  it("is scheduled when approved + deps ok but timing not yet due", () => {
    const ledger: GateEntry[] = [
      { kind: "timing", state: "pending", reason: "Not due until 2026-06-01" },
      { kind: "dependency", state: "passed" },
      { kind: "approval", state: "not_required" },
    ];
    expect(deriveEffectiveGateState(ledger).state).toBe("scheduled");
  });

  it("is blocked when a dependency gate is blocked, and explains why", () => {
    const ledger: GateEntry[] = [
      { kind: "timing", state: "passed" },
      { kind: "dependency", state: "blocked", reason: "Upstream task 'blog' failed", blockerRefs: ["blog"] },
      { kind: "approval", state: "not_required" },
    ];
    const ev = deriveEffectiveGateState(ledger);
    expect(ev.state).toBe("blocked");
    expect(ev.blockers).toEqual([
      { kind: "dependency", reason: "Upstream task 'blog' failed", blockerRefs: ["blog"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Foreach-only transition preconditions
// ---------------------------------------------------------------------------
import {
  assertForeachIdleSkip,
  assertForeachIdleFail,
  assertForeachIdleSucceeded,
  ForeachPreconditionError,
} from "../state/transitions";

describe("foreach idle→skipped/failed/succeeded — narrow helpers (T4)", () => {
  it("generic matrix continues to reject idle → skipped/failed/succeeded for normal tasks", () => {
    expect(canTransition("task", "idle", "skipped")).toBe(false);
    expect(canTransition("task", "idle", "failed")).toBe(false);
    expect(canTransition("task", "idle", "succeeded")).toBe(false);
    expect(() => assertTransition("task", "idle", "skipped")).toThrow(TransitionError);
    expect(() => assertTransition("task", "idle", "failed")).toThrow(TransitionError);
    expect(() => assertTransition("task", "idle", "succeeded")).toThrow(TransitionError);
  });

  it("assertForeachIdleSkip: source=skipped → ok; source=failed+failurePolicy=skip → ok", () => {
    expect(() => assertForeachIdleSkip("p1", "skipped", "block")).not.toThrow();
    expect(() => assertForeachIdleSkip("p1", "skipped", "skip")).not.toThrow();
    expect(() => assertForeachIdleSkip("p1", "skipped", null)).not.toThrow();
    expect(() => assertForeachIdleSkip("p1", "failed", "skip")).not.toThrow();
  });

  it("assertForeachIdleSkip: source=failed+failurePolicy=block → throws", () => {
    expect(() => assertForeachIdleSkip("p1", "failed", "block")).toThrow(ForeachPreconditionError);
    expect(() => assertForeachIdleSkip("p1", "failed", null)).toThrow(ForeachPreconditionError);
  });

  it("assertForeachIdleFail: any non-empty foreach_* code → ok", () => {
    expect(() => assertForeachIdleFail("p1", "foreach_invalid_source_output")).not.toThrow();
    expect(() => assertForeachIdleFail("p1", "foreach_max_fanout_exceeded")).not.toThrow();
  });

  it("assertForeachIdleFail: empty / non-foreach code → throws", () => {
    expect(() => assertForeachIdleFail("p1", "")).toThrow(ForeachPreconditionError);
    expect(() => assertForeachIdleFail("p1", "random_error_code")).toThrow(ForeachPreconditionError);
  });

  it("assertForeachIdleSucceeded: 0 items → ok, >0 items → throws", () => {
    expect(() => assertForeachIdleSucceeded("p1", 0)).not.toThrow();
    expect(() => assertForeachIdleSucceeded("p1", 1)).toThrow(ForeachPreconditionError);
  });
});
