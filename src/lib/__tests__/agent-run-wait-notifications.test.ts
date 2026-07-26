// cinatra #1559 / notifications epic E9 — run "awaiting human" durable
// notification. Two layers:
//   1. the PURE builder + dedupeKey (no I/O), and
//   2. the host RunWaitNotifier lifecycle (emit-on-enter / clear-on-leave),
//      driven with the run store + notifications /server writers mocked.
//
// Pins the AC: emit-on-wait, dedup (stable per-run key), clear-on-resolve,
// no-initiator skip, the already-resolved fast-path guard, and best-effort
// (a write failure never throws).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUN_AWAITING_HUMAN_CATEGORY } from "@cinatra-ai/notifications/flyout-state";

// --- mocks for the notifier's lazy dynamic imports -------------------------
const readAgentRunById =
  vi.fn<
    (id: string) => Promise<{ id: string; runBy: string | null; title: string | null; status: string } | null>
  >();
const createNotificationForRecipient = vi.fn(
  async (_recipient: { kind: string; userId: string }, _input: any): Promise<Array<{ id: string }>> => [
    { id: "notif-1" },
  ],
);
const deleteNotificationsByDedupeKeyForUser = vi.fn(
  (_args: { userId: string; dedupeKey: string }): void => {},
);
const resolveAgentRunHref = vi.fn(async (_jobData: unknown) => "/agents/acme/sales/R1");

// Side-effect host-adapter registration — a no-op in the test.
vi.mock("@/lib/notifications-host", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({ readAgentRunById }));
vi.mock("@cinatra-ai/notifications/server", () => ({
  createNotificationForRecipient,
  deleteNotificationsByDedupeKeyForUser,
  resolveAgentRunHref,
}));

import {
  buildRunAwaitingHumanNotificationInput,
  runAwaitingHumanDedupeKey,
  buildAutoGateOpenNotificationInput,
  autoGateOpenDedupeKey,
  runWaitNotifier,
} from "@/lib/agent-run-wait-notifications";

beforeEach(() => {
  readAgentRunById.mockReset();
  createNotificationForRecipient.mockReset();
  createNotificationForRecipient.mockResolvedValue([{ id: "notif-1" }]);
  deleteNotificationsByDedupeKeyForUser.mockReset();
  resolveAgentRunHref.mockReset();
  resolveAgentRunHref.mockResolvedValue("/agents/acme/sales/R1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PURE builder
// ---------------------------------------------------------------------------
describe("buildRunAwaitingHumanNotificationInput — pure shape", () => {
  it("dedupeKey is stable per run (run/wait dedup) and prefix-tagged", () => {
    expect(runAwaitingHumanDedupeKey("R1")).toBe("run-awaiting-human:R1");
    const a = buildRunAwaitingHumanNotificationInput({ runId: "R1", reason: "pending_approval" });
    const b = buildRunAwaitingHumanNotificationInput({ runId: "R1", reason: "pending_input" });
    expect(a.dedupeKey).toBe("run-awaiting-human:R1");
    // Same run → same key regardless of reason, so the service collapses to ONE row.
    expect(b.dedupeKey).toBe(a.dedupeKey);
  });

  it("is an actionable warning tagged with the run_awaiting_human category + payload", () => {
    const input = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_approval",
      runTitle: "Nightly sync",
      href: "/agents/acme/sales/R1",
    });
    expect(input.kind).toBe("warning");
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.title).toBe('"Nightly sync" is awaiting your approval');
    expect(input.metadata).toMatchObject({
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: { runId: "R1", reason: "pending_approval" },
    });
  });

  it("varies copy by reason and falls back to a generic subject with no run title", () => {
    const input = buildRunAwaitingHumanNotificationInput({ runId: "R1", reason: "pending_input" });
    expect(input.title).toBe("A run is waiting on you to continue");
    expect(input.href).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Host lifecycle — emit on enter
// ---------------------------------------------------------------------------
describe("runWaitNotifier.onEnterHumanWait — emit-on-wait", () => {
  it("mints exactly one durable actionable notification to the initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Nightly sync", status: "pending_approval" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const [recipient, input] = (createNotificationForRecipient.mock.calls as any[])[0];
    expect(recipient).toEqual({ kind: "user", userId: "U1" });
    expect(input.dedupeKey).toBe("run-awaiting-human:R1");
    expect(input.kind).toBe("warning");
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.metadata.category).toBe(RUN_AWAITING_HUMAN_CATEGORY);
  });

  it("re-emits with the SAME dedupeKey (dedup — service collapses to one row)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "pending_approval" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });
    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).toHaveBeenCalledTimes(2);
    const key0 = (createNotificationForRecipient.mock.calls as any[])[0][1].dedupeKey;
    const key1 = (createNotificationForRecipient.mock.calls as any[])[1][1].dedupeKey;
    expect(key1).toBe(key0);
  });

  it("skips emit when the run has no initiator (system-/trigger-launched run)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "pending_approval" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("skips emit when the run already LEFT the gate before this enter ran (fast-path guard)", async () => {
    // A concurrent resume/stop won the leave (status is now terminal) before
    // this delayed enter resolved the run — do NOT resurrect a notification.
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "stopped" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("marks the stop-run-hitl pending_input reason on the payload", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "pending_input" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_input" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.metadata.runAwaitingHuman.reason).toBe("pending_input");
  });

  it("never throws when the notification write fails (best-effort)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "pending_approval" });
    createNotificationForRecipient.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Host lifecycle — clear on leave
// ---------------------------------------------------------------------------
describe("runWaitNotifier.onLeaveHumanWait — clear-on-resolve", () => {
  it("hard-deletes the initiator's row by the per-run dedupeKey (unconditional)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "completed" });

    await runWaitNotifier.onLeaveHumanWait({ runId: "R1" });

    expect(deleteNotificationsByDedupeKeyForUser).toHaveBeenCalledWith({
      userId: "U1",
      dedupeKey: "run-awaiting-human:R1",
    });
  });

  it("skips the clear when the run has no initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "completed" });

    await runWaitNotifier.onLeaveHumanWait({ runId: "R1" });

    expect(deleteNotificationsByDedupeKeyForUser).not.toHaveBeenCalled();
  });

  it("never throws when the run lookup fails (best-effort)", async () => {
    readAgentRunById.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runWaitNotifier.onLeaveHumanWait({ runId: "R1" }),
    ).resolves.toBeUndefined();
    expect(deleteNotificationsByDedupeKeyForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2066 C2 — lifecycle auto-gate-open notification (open + clear)
// ---------------------------------------------------------------------------
describe("buildAutoGateOpenNotificationInput — pure shape", () => {
  it("dedupeKey is per (run, reviewTaskId) and under the awaiting-human family", () => {
    const key = autoGateOpenDedupeKey("R1", "auto-review-abc");
    expect(key).toBe("run-awaiting-human:auto:R1:auto-review-abc");
    // Distinct per task on the same run (two concurrent auto-gates never collide)
    expect(autoGateOpenDedupeKey("R1", "t2")).not.toBe(key);
    // Distinct from the per-run flow-authored human-wait key on the same run.
    expect(key).not.toBe(runAwaitingHumanDedupeKey("R1"));
  });

  it("is an actionable warning in the run-awaiting-human category, deep-linking to the run view", () => {
    const input = buildAutoGateOpenNotificationInput({
      runId: "R1",
      reviewTaskId: "auto-review-abc",
      runTitle: "Nightly digest",
      href: "/agents/acme/sales/R1",
    });
    expect(input.kind).toBe("warning");
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.title).toContain("Nightly digest");
    expect(input.dedupeKey).toBe("run-awaiting-human:auto:R1:auto-review-abc");
    expect(input.metadata).toMatchObject({
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: { runId: "R1", reason: "pending_approval" },
    });
  });

  it("falls back to a generic subject when the run has no title", () => {
    const input = buildAutoGateOpenNotificationInput({
      runId: "R1",
      reviewTaskId: "t",
    });
    expect(input.title.startsWith("A run")).toBe(true);
    expect(input.href).toBeUndefined();
  });
});

describe("runWaitNotifier.onAutoGateOpen — emit on auto-gate open", () => {
  it("mints one notification to the initiator with the run-view href — NO wait-status guard", async () => {
    // The producing run is NOT parked on pending_approval (it is 'running'): an
    // auto-gate never moves the run to a wait state, so the emit must fire anyway.
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: "Digest", status: "running" });
    await runWaitNotifier.onAutoGateOpen!({ runId: "R1", reviewTaskId: "auto-review-abc" });
    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const [recipient, input] = createNotificationForRecipient.mock.calls[0];
    expect(recipient).toEqual({ kind: "user", userId: "user-1" });
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.dedupeKey).toBe("run-awaiting-human:auto:R1:auto-review-abc");
  });

  it("skips the emit for a run with no initiator (synthetic orphan / system run)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "running" });
    await runWaitNotifier.onAutoGateOpen!({ runId: "R1", reviewTaskId: "t" });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("never throws when the write fails (best-effort)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "running" });
    createNotificationForRecipient.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      runWaitNotifier.onAutoGateOpen!({ runId: "R1", reviewTaskId: "t" }),
    ).resolves.toBeUndefined();
  });
});

describe("runWaitNotifier.onAutoGateResolved — clear on terminal decision", () => {
  it("hard-deletes the initiator's row by the per-(run, task) auto-gate key", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "completed" });
    await runWaitNotifier.onAutoGateResolved!({ runId: "R1", reviewTaskId: "auto-review-abc" });
    expect(deleteNotificationsByDedupeKeyForUser).toHaveBeenCalledWith({
      userId: "user-1",
      dedupeKey: "run-awaiting-human:auto:R1:auto-review-abc",
    });
  });

  it("skips the clear when the run has no initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "completed" });
    await runWaitNotifier.onAutoGateResolved!({ runId: "R1", reviewTaskId: "t" });
    expect(deleteNotificationsByDedupeKeyForUser).not.toHaveBeenCalled();
  });
});
