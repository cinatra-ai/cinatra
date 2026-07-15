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
