/**
 * cinatra#2066 C2 — lifecycle auto-gate-open notification wiring.
 *
 * The run-embedding audit's C2 must-cover list requires that when a lifecycle
 * AUTO-GATE opens, a durable user notification fires and deep-links to the run
 * view for the reviewer-resolvable audience the gate computes.
 *
 * Grounding (2026-07-25, Codex-confirmed) established that a lifecycle auto-gate
 * is DISTINCT from a flow-authored HITL gate: the #2039 review-orchestration path
 * creates it via `emitArtifactReviewGate` + a continuation park and NEVER moves
 * the producing run to `pending_approval`, so the human-wait classifier / run-wait
 * notifier never fires for it. Before this change NO notification was minted when
 * an auto-gate opened. This slice adds an OPTIONAL `onAutoGateOpen` /
 * `onAutoGateResolved` pair on the `RunWaitNotifier` seam, driven by
 * `dispatchAutoGateOpen` (from the orchestration store, on a NEW auto-gate) and
 * `dispatchAutoGateResolved` (from the gate-decision commit, on a TERMINAL
 * resolution). The host impl (agent-run-wait-notifications.ts) mints/clears the
 * row to the run initiator with a run-view deep-link — covered in
 * src/lib/__tests__/agent-run-wait-notifications.test.ts.
 *
 * This file covers the PACKAGE-side seam: the dispatchers drive the wired
 * notifier's optional methods, skip cleanly when a host wires none (or wires one
 * without the optional methods), and are best-effort (a throwing port never
 * propagates — an auto-gate notification can never fail orchestration or a
 * committed review decision).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  setRunWaitNotifier,
  dispatchAutoGateOpen,
  dispatchAutoGateResolved,
  buildAutoGateNotificationFence,
  AUTO_GATE_TABLE,
  type RunWaitNotifier,
} from "../run-wait-notifier";

const OPEN = { runId: "run-1", reviewTaskId: "auto-review-abc" };

/**
 * cinatra#2864 — the four review-task-id SHAPES the open seam serves, one per
 * gate-opening path.
 *
 * HONEST SCOPE. Only the first shape has a dispatching caller on this branch
 * (`orchestrateProducedEvent`). cinatra#2833
 * (https://github.com/cinatra-ai/cinatra/pull/2838, open) adds the other three
 * callers, and each calls `dispatchAutoGateOpen` with the same two ids. So this
 * table does NOT claim four production paths run today; it pins that the seam and
 * the fence are SHAPE-BLIND, which is what lets those three arrive already fenced
 * with no change to the code that adds them.
 *
 * The id shapes are the real ones (`@/lib/lifecycle/lifecycle-orchestration`
 * builds them: `auto-review:`, its batch/repair/verify supersets). They are
 * spelled literally here because this file is a PURE seam test with no store.
 */
const OPENING_PATHS = [
  {
    path: "orchestrateProducedEvent — the single produced artifact",
    reviewTaskId: "auto-review:evt-single-1",
  },
  {
    path: "orchestrateProducedBatch — the batch partition gate",
    reviewTaskId: "auto-review:batch:part-1",
  },
  {
    path: "submitRepairResponse — the repair-successor pin",
    reviewTaskId: "auto-review:repair:rep-1:2",
  },
  {
    path: "writeVerificationRecordAndMaybeReopen — the verification reopen pin",
    reviewTaskId: "auto-review:verify-reopen:ver-1",
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Never leak the wired notifier into another test file's module singleton.
  setRunWaitNotifier(null);
});

describe("cinatra#2066 C2 — dispatchAutoGateOpen drives the wired notifier", () => {
  it("calls onAutoGateOpen with the {runId, reviewTaskId} of the opened gate", async () => {
    const onAutoGateOpen = vi.fn(async () => undefined);
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
      onAutoGateOpen,
    } as RunWaitNotifier);

    await dispatchAutoGateOpen(OPEN);

    expect(onAutoGateOpen).toHaveBeenCalledTimes(1);
    expect(onAutoGateOpen).toHaveBeenCalledWith(OPEN);
  });

  it("is a no-op when no host wired a notifier", async () => {
    setRunWaitNotifier(null);
    await expect(dispatchAutoGateOpen(OPEN)).resolves.toBeUndefined();
  });

  it("is a no-op when the wired notifier omits the OPTIONAL onAutoGateOpen", async () => {
    // A host on the pre-C2 seam (only the two required methods) must not throw.
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    } as RunWaitNotifier);
    await expect(dispatchAutoGateOpen(OPEN)).resolves.toBeUndefined();
  });

  it("swallows a throwing notifier so orchestration can never fail on a notification", async () => {
    const onAutoGateOpen = vi.fn(async () => {
      throw new Error("notifications down");
    });
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
      onAutoGateOpen,
    } as RunWaitNotifier);

    await expect(dispatchAutoGateOpen(OPEN)).resolves.toBeUndefined();
    expect(onAutoGateOpen).toHaveBeenCalledTimes(1);
  });
});

describe("cinatra#2066 C2 — dispatchAutoGateResolved drives the clear", () => {
  it("calls onAutoGateResolved with the same {runId, reviewTaskId} key", async () => {
    const onAutoGateResolved = vi.fn(async () => undefined);
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
      onAutoGateResolved,
    } as RunWaitNotifier);

    await dispatchAutoGateResolved(OPEN);

    expect(onAutoGateResolved).toHaveBeenCalledWith(OPEN);
  });

  it("is a no-op when the wired notifier omits the OPTIONAL onAutoGateResolved", async () => {
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    } as RunWaitNotifier);
    await expect(dispatchAutoGateResolved(OPEN)).resolves.toBeUndefined();
  });

  it("swallows a throwing clear so a committed review decision can never fail", async () => {
    setRunWaitNotifier({
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
      onAutoGateResolved: vi.fn(async () => {
        throw new Error("notifications down");
      }),
    } as RunWaitNotifier);
    await expect(dispatchAutoGateResolved(OPEN)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2864 — the open's subject-check, moved INTO the write.
// ---------------------------------------------------------------------------

describe("cinatra#2864 — buildAutoGateNotificationFence", () => {
  const fence = buildAutoGateNotificationFence({
    schema: "cinatra",
    runId: "run-1",
    reviewTaskId: "auto-review-abc",
  });

  it("guards on the GATE's own row, matched on (run, task) and STILL PENDING", () => {
    // Every clause matters: the run and task identify the gate the notification
    // announces, and `status = 'pending'` is the whole point — a gate that already
    // reached a terminal decision must yield no row, so the insert this feeds
    // writes nothing.
    expect(fence.guard).toContain(`"cinatra"."${AUTO_GATE_TABLE}"`);
    expect(fence.guard).toContain("run_id = $1");
    expect(fence.guard).toContain("review_task_id = $2");
    expect(fence.guard).toContain("status = 'pending'");
  });

  it("takes the gate's ROW LOCK — the lock the terminal decision's CAS also takes", () => {
    // Without FOR UPDATE the guard is just a read: it would answer truthfully and
    // then be overtaken, which is the defect. With it, the open and the decision
    // serialise on the gate row.
    expect(fence.guard).toMatch(/FOR UPDATE\s*$/);
  });

  it("numbers its placeholders from $1 and carries exactly the two ids", () => {
    // The insert's row values are numbered BEHIND these, so the caller never has
    // to know how many columns the notification insert carries.
    expect(fence.values).toEqual(["run-1", "auto-review-abc"]);
  });

  it("quotes the schema so an identifier can never break out of the statement", () => {
    const hostile = buildAutoGateNotificationFence({
      schema: 'ev"il',
      runId: "r",
      reviewTaskId: "t",
    });
    expect(hostile.guard).toContain('"ev""il"."artifact_review_gates"');
  });

  it("carries NO caller-supplied identity beyond the two ids the seam already has", () => {
    // The fence asserts nothing on the caller's word: a gate id, an org, or a
    // status handed in by a caller would be a claim. These two ids are the seam's
    // own key, and the gate table answers everything else.
    expect(Object.keys(fence)).toEqual(["values", "guard"]);
  });
});

describe("cinatra#2864 — ONE seam, shape-blind, for every opening path", () => {
  it.each(OPENING_PATHS)(
    "$path reaches the notifier through the same dispatch, with its own (run, task)",
    async ({ reviewTaskId }) => {
      const onAutoGateOpen = vi.fn(async () => undefined);
      setRunWaitNotifier({
        onEnterHumanWait: vi.fn(),
        onLeaveHumanWait: vi.fn(),
        onAutoGateOpen,
      } as RunWaitNotifier);

      await dispatchAutoGateOpen({ runId: "run-4", reviewTaskId });

      expect(onAutoGateOpen).toHaveBeenCalledTimes(1);
      expect(onAutoGateOpen).toHaveBeenCalledWith({ runId: "run-4", reviewTaskId });
    },
  );

  it.each(OPENING_PATHS)(
    "$path fences on the SAME gate predicate — no path-by-path variant",
    ({ reviewTaskId }) => {
      const fence = buildAutoGateNotificationFence({
        schema: "cinatra",
        runId: "run-4",
        reviewTaskId,
      });
      // The task-id SHAPE differs per path; the fence does not. It keys on the
      // (run, task) pair and on the gate being pending, whatever minted it.
      expect(fence.values).toEqual(["run-4", reviewTaskId]);
      expect(fence.guard).toBe(
        buildAutoGateNotificationFence({
          schema: "cinatra",
          runId: "run-4",
          reviewTaskId: "any-other-task",
        }).guard,
      );
    },
  );
});
