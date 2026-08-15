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

import { RUN_AWAITING_HUMAN_CATEGORY, RUN_FAILED_CATEGORY } from "@cinatra-ai/notifications/flyout-state";

// --- mocks for the notifier's lazy dynamic imports -------------------------
const readAgentRunById =
  vi.fn<
    (
      id: string,
    ) => Promise<{
      id: string;
      runBy: string | null;
      title: string | null;
      status: string;
      error?: string | null;
    } | null>
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
// The canonical "which gate is this run paused on" derivation. The notifier
// reads it purely to pick INPUT-vs-APPROVAL copy; null (its default here) is
// the fail-closed case that keeps the pre-existing approval wording.
const deriveRunHitlContext =
  vi.fn<
    (run: unknown) => Promise<{ reviewTaskId?: string; fieldName?: string } | null>
  >();

// The chat-side "which conversation is this run playing out in" lookup
// (cinatra#2729). Default null == no conversation resolvable, which is the
// fallback-to-the-run-page case.
const findChatConversationPathForAgentRun = vi.fn<(runId: string) => string | null>();

// Side-effect host-adapter registration — a no-op in the test.
vi.mock("@/lib/notifications-host", () => ({}));
vi.mock("@/lib/assistant-thread-store", () => ({
  findChatConversationPathForAgentRun,
}));
vi.mock("@cinatra-ai/agents", () => ({ readAgentRunById, deriveRunHitlContext }));
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
  buildRunFailedNotificationInput,
  runFailedDedupeKey,
  runWaitNotifier,
} from "@/lib/agent-run-wait-notifications";

beforeEach(() => {
  readAgentRunById.mockReset();
  deriveRunHitlContext.mockReset();
  deriveRunHitlContext.mockResolvedValue(null);
  createNotificationForRecipient.mockReset();
  createNotificationForRecipient.mockResolvedValue([{ id: "notif-1" }]);
  deleteNotificationsByDedupeKeyForUser.mockReset();
  resolveAgentRunHref.mockReset();
  resolveAgentRunHref.mockResolvedValue("/agents/acme/sales/R1");
  findChatConversationPathForAgentRun.mockReset();
  findChatConversationPathForAgentRun.mockReturnValue(null);
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
// Notification-surface COPY fixtures for the input-vs-approval discriminator.
//
// Both cases below carry reason `pending_approval` — the enum cannot separate
// them. Only the interrupt's semantics can, and the row must not tell a user to
// "approve" a run that is merely collecting a missing field.
// ---------------------------------------------------------------------------
describe("buildRunAwaitingHumanNotificationInput — input vs approval copy", () => {
  const SETUP_INPUT_INTERRUPT = { reviewTaskId: "setup-R1", fieldName: "idea" };
  const REVIEW_GATE_INTERRUPT = { reviewTaskId: "9f1c2f0e-6f1a-4a1b-9f2e-0c3d4e5f6a7b" };

  it("a setup-field INPUT pause asks for input, never for approval", () => {
    const input = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_approval",
      runTitle: "Blog draft",
      interrupt: SETUP_INPUT_INTERRUPT,
    });
    expect(input.title).toBe('"Blog draft" needs your input');
    expect(input.body).toBe("Open the run to fill in the requested fields.");
    expect(`${input.title} ${input.body}`.toLowerCase()).not.toContain("approv");
  });

  it("a genuine review gate keeps the unchanged approval copy", () => {
    const input = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_approval",
      runTitle: "Nightly sync",
      interrupt: REVIEW_GATE_INTERRUPT,
    });
    expect(input.title).toBe('"Nightly sync" is awaiting your approval');
    expect(input.body).toBe("Open the run to review and approve the pending step.");
  });

  it("leaves the reason payload untouched — copy only, no state or enum change", () => {
    const input = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_approval",
      interrupt: SETUP_INPUT_INTERRUPT,
    });
    expect(input.metadata).toMatchObject({
      runAwaitingHuman: { runId: "R1", reason: "pending_approval" },
    });
    expect(input.dedupeKey).toBe("run-awaiting-human:R1");
    expect(input.kind).toBe("warning");
  });

  it("the stop-run-hitl pending_input row is unaffected by the discriminator", () => {
    const input = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_input",
      interrupt: SETUP_INPUT_INTERRUPT,
    });
    expect(input.title).toBe("A run is waiting on you to continue");
    expect(input.body).toBe("Open the run to resolve the gate so it can continue.");
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

  it("threads the DERIVED interrupt into the copy — a setup pause reads as input", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Blog draft", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "setup-R1", fieldName: "idea" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.title).toBe('"Blog draft" needs your input');
    expect(input.body).toBe("Open the run to fill in the requested fields.");
    // Still the same durable row identity + reason — presentation only.
    expect(input.dedupeKey).toBe("run-awaiting-human:R1");
    expect(input.metadata.runAwaitingHuman.reason).toBe("pending_approval");
  });

  it("keeps the approval copy for a genuine review gate", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Nightly sync", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "wayflow-task-7" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.title).toBe('"Nightly sync" is awaiting your approval');
  });

  it("still emits when the gate derivation fails (copy refinement is best-effort)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Nightly sync", status: "pending_approval" });
    deriveRunHitlContext.mockRejectedValue(new Error("redis down"));

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.title).toBe('"Nightly sync" is awaiting your approval');
  });

  it("does not derive a gate context for the pending_input wait", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "pending_input" });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_input" });

    expect(deriveRunHitlContext).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // WHERE THE NOTIFICATION LANDS (cinatra#2729)
  // -------------------------------------------------------------------------
  it("returns an INPUT wait to the conversation the run is playing out in", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Blog draft", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "setup-R1", fieldName: "idea" });
    findChatConversationPathForAgentRun.mockReturnValue(
      "/chat/cinatra-ai/cinatra-assistant/blog-draft",
    );

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(findChatConversationPathForAgentRun).toHaveBeenCalledWith("R1");
    expect(input.href).toBe("/chat/cinatra-ai/cinatra-assistant/blog-draft");
  });

  it("keeps the run page for an input wait with no resolvable conversation", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Blog draft", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "setup-R1", fieldName: "idea" });
    findChatConversationPathForAgentRun.mockReturnValue(null);

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.href).toBe("/agents/acme/sales/R1");
  });

  it("sends a genuine APPROVAL gate to the run page, never to a conversation", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Nightly sync", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "wayflow-task-7" });
    findChatConversationPathForAgentRun.mockReturnValue("/chat/cinatra-ai/cinatra-assistant/t1");

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(findChatConversationPathForAgentRun).not.toHaveBeenCalled();
    expect(input.href).toBe("/agents/acme/sales/R1");
  });

  it("still emits when the conversation lookup throws (best-effort)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Blog draft", status: "pending_approval" });
    deriveRunHitlContext.mockResolvedValue({ reviewTaskId: "setup-R1", fieldName: "idea" });
    findChatConversationPathForAgentRun.mockImplementation(() => {
      throw new Error("store down");
    });

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_approval" });

    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const input = (createNotificationForRecipient.mock.calls as any[])[0][1];
    expect(input.href).toBe("/agents/acme/sales/R1");
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
// cinatra#2413 — run-failure notification (supersedes onLeaveHumanWait's bare
// delete when the leave is a FAILURE, not a human decision). Pins the AC:
// enter pending_approval (assert approval row — covered above), transition to
// failed (assert the approval row is cleared AND a failure row is minted).
// ---------------------------------------------------------------------------
describe("buildRunFailedNotificationInput — pure shape", () => {
  it("dedupeKey is stable per run and DISTINCT from the awaiting-human family", () => {
    expect(runFailedDedupeKey("R1")).toBe("run-failed:R1");
    expect(runFailedDedupeKey("R1")).not.toBe(runAwaitingHumanDedupeKey("R1"));
  });

  it("is a destructive 'error' kind tagged with the run_failed category + payload", () => {
    const input = buildRunFailedNotificationInput({
      runId: "R1",
      runTitle: "Nightly sync",
      href: "/agents/acme/sales/R1",
      error: "WayFlow task failed",
    });
    expect(input.kind).toBe("error");
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.title).toBe('"Nightly sync" failed');
    expect(input.body).toContain("WayFlow task failed");
    expect(input.metadata).toMatchObject({
      category: RUN_FAILED_CATEGORY,
      runFailed: { runId: "R1" },
    });
  });

  it("falls back to a generic subject + body with no title/error", () => {
    const input = buildRunFailedNotificationInput({ runId: "R1" });
    expect(input.title).toBe("A run failed");
    expect(input.body).toBe("The run failed while awaiting your approval.");
    expect(input.href).toBeUndefined();
  });
});

describe("runWaitNotifier.onHumanWaitFailed — supersede-on-failure", () => {
  it("clears the stale approval row AND mints a run-failure row to the initiator", async () => {
    readAgentRunById.mockResolvedValue({
      id: "R1",
      runBy: "U1",
      title: "Nightly sync",
      status: "failed",
      error: "WayFlow task failed",
    });

    await runWaitNotifier.onHumanWaitFailed!({ runId: "R1" });

    // The approval row is superseded, not left dangling.
    expect(deleteNotificationsByDedupeKeyForUser).toHaveBeenCalledWith({
      userId: "U1",
      dedupeKey: "run-awaiting-human:R1",
    });
    // A failure row replaces it — the feed is never silent.
    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const [recipient, input] = createNotificationForRecipient.mock.calls[0]!;
    expect(recipient).toEqual({ kind: "user", userId: "U1" });
    expect(input.dedupeKey).toBe("run-failed:R1");
    expect(input.kind).toBe("error");
    expect(input.href).toBe("/agents/acme/sales/R1");
    expect(input.metadata.category).toBe(RUN_FAILED_CATEGORY);
    expect(input.metadata.runFailed).toEqual({ runId: "R1" });
  });

  it("skips both the clear and the mint when the run has no initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "failed" });

    await runWaitNotifier.onHumanWaitFailed!({ runId: "R1" });

    expect(deleteNotificationsByDedupeKeyForUser).not.toHaveBeenCalled();
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("never throws when the notification write fails (best-effort)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: null, status: "failed" });
    createNotificationForRecipient.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runWaitNotifier.onHumanWaitFailed!({ runId: "R1" })).resolves.toBeUndefined();
  });

  it("never throws when the run lookup fails (best-effort)", async () => {
    readAgentRunById.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runWaitNotifier.onHumanWaitFailed!({ runId: "R1" })).resolves.toBeUndefined();
    expect(deleteNotificationsByDedupeKeyForUser).not.toHaveBeenCalled();
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
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
