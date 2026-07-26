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
  type RunWaitNotifier,
} from "../run-wait-notifier";

const OPEN = { runId: "run-1", reviewTaskId: "auto-review-abc" };

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
