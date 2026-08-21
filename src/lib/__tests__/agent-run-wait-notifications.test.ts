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
// cinatra#2882 — the notifier clears through the ASYNC seam now. Its sync twin
// is still exported by the package (genuinely synchronous hosts keep it), but a
// notifier that reached for it would be parking this thread on `Atomics.wait`,
// so this mock deliberately supplies ONLY the async name: a regression back to
// the sync call would destructure `undefined` and fail here rather than pass
// quietly.
const deleteNotificationsByDedupeKeyForUserAsync = vi.fn(
  async (_args: { userId: string; dedupeKey: string }): Promise<void> => {},
);
// cinatra#2835 — the HOLD-scoped clear: same per-run key, additionally pinned to
// the park id the row carries. Returns whether the delete committed; that answer
// is the sweeper's ack.
//
// cinatra#2882 — and it clears through the ASYNC seam too, under the SAME trap
// as the key-scoped clear above: only the async name is exported below, so a
// regression back to the synchronous bridge destructures `undefined` rather than
// passing quietly. Async here also changes what a FAILURE looks like — a
// rejection, not a throw — which is why the failure arm below rejects.
const deleteHoldNotificationForUserAsync = vi.fn(
  async (_args: {
    userId: string;
    dedupeKey: string;
    holdParkId: string;
  }): Promise<boolean> => true,
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
  deleteNotificationsByDedupeKeyForUserAsync,
  deleteHoldNotificationForUserAsync,
  resolveAgentRunHref,
  // cinatra#2838 — the real value, not a stand-in: the host hands it to the park
  // package so the `mark` can gate itself on the insert's RETURNING, and a test
  // double that renamed it would let a broken gate pass.
  NOTIFICATION_WRITE_CTE: "notification_write",
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
  deleteNotificationsByDedupeKeyForUserAsync.mockReset();
  deleteHoldNotificationForUserAsync.mockReset();
  deleteHoldNotificationForUserAsync.mockResolvedValue(true);
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

  it("an explicit input waitKind selects the input copy for EITHER reason (cinatra#2835)", () => {
    // The recommendation hold's case: a `pending_input` wait with no interrupt to
    // classify, which the reason-only derivation would have called a generic
    // continue-wait.
    const held = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_input",
      runTitle: "Blog draft",
      waitKind: "input",
    });
    expect(held.title).toBe('"Blog draft" needs your input');
    // The hold lands on the skills chip row (Confirm/Skip), not on a form with
    // fields, so it does NOT share the derived input wait's body. Interim wording —
    // the final copy is cinatra#2838's reserved decision; what this pins is that the
    // hold's body does not promise fields its destination has not got.
    expect(held.body).toBe("Open the run to confirm or skip the recommended skills.");
    expect(held.body).not.toContain("fields");
    // Same per-run key + payload as any other human wait on this run.
    expect(held.dedupeKey).toBe(runAwaitingHumanDedupeKey("R1"));
    expect(held.metadata).toMatchObject({
      runAwaitingHuman: { runId: "R1", reason: "pending_input" },
    });

    // An APPROVAL waitKind (or none) leaves the pre-existing derivation alone.
    const approval = buildRunAwaitingHumanNotificationInput({
      runId: "R1",
      reason: "pending_approval",
      runTitle: "Nightly sync",
      waitKind: "approval",
    });
    expect(approval.title).toBe('"Nightly sync" is awaiting your approval');
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

  // -------------------------------------------------------------------------
  // THE RECOMMENDATION HOLD IS NOT THIS SEAM (cinatra#2838)
  //
  // A hold used to be able to reach the copy through this seam, by handing it a
  // `waitKind` the transition caller never had. No production caller ever did —
  // `transitionRunStatus` is the only caller here, and it knows only that a status
  // changed — so the field was dead and is gone. The hold enters through
  // `onEnterRecommendationHold` (its own describe block below), which is where its
  // classification, its conversation link and its fenced write are pinned.
  //
  // What stays pinned HERE is the other side of that removal: this seam DERIVES,
  // and a `pending_input` wait it cannot derive an interrupt for keeps the generic
  // continue-copy and the run page.
  // -------------------------------------------------------------------------
  it("a pending_input wait keeps its pre-existing copy and destination", async () => {
    // The #1058 stop-run-hitl pause — the flagged `pending_input` wait — must be
    // untouched by this slice.
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "U1", title: "Blog draft", status: "pending_input" });
    findChatConversationPathForAgentRun.mockReturnValue("/chat/cinatra-ai/cinatra-assistant/t1");

    await runWaitNotifier.onEnterHumanWait({ runId: "R1", reason: "pending_input" });

    const input = createNotificationForRecipient.mock.calls[0][1];
    expect(input.title).toBe('"Blog draft" is waiting on you to continue');
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

    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledWith({
      userId: "U1",
      dedupeKey: "run-awaiting-human:R1",
    });
  });

  it("skips the clear when the run has no initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "completed" });

    await runWaitNotifier.onLeaveHumanWait({ runId: "R1" });

    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
  });

  it("never throws when the run lookup fails (best-effort)", async () => {
    readAgentRunById.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runWaitNotifier.onLeaveHumanWait({ runId: "R1" }),
    ).resolves.toBeUndefined();
    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
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
    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledWith({
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

    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
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
    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
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

  // cinatra#2864 — the row is written behind the GATE's own row, in the same
  // statement. Without this the pair had no ordering: a resolve-delete that ran
  // while this insert was in flight matched nothing, the insert then committed,
  // and the row outlived the review it announced. The ordering property itself is
  // proven against a real database in
  // packages/agents/src/__tests__/auto-gate-notification-ordering.integration.test.ts;
  // what this pins is the HAND-OFF — that the host actually asks for the fence.
  it("cinatra#2864: fences the insert on the gate row, still pending, FOR UPDATE", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: "Digest", status: "running" });
    await runWaitNotifier.onAutoGateOpen!({ runId: "R1", reviewTaskId: "auto-review-abc" });

    // The production call passes a third `options` argument the local mock's
    // signature does not declare; read it positionally.
    const options = (createNotificationForRecipient.mock.calls[0] as unknown[])[2] as {
      recipientUserIds?: string[];
      fence?: { values: unknown[]; precondition: string };
    };
    expect(options.fence).toBeDefined();
    expect(options.fence!.values).toEqual(["R1", "auto-review-abc"]);
    expect(options.fence!.precondition).toContain("artifact_review_gates");
    expect(options.fence!.precondition).toContain("status = 'pending'");
    expect(options.fence!.precondition).toContain("FOR UPDATE");
    // One already-resolved recipient, so the fence takes ONE gate row lock for
    // ONE insert rather than once per expanded recipient.
    expect(options.recipientUserIds).toEqual(["user-1"]);
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
    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledWith({
      userId: "user-1",
      dedupeKey: "run-awaiting-human:auto:R1:auto-review-abc",
    });
  });

  it("skips the clear when the run has no initiator", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "completed" });
    await runWaitNotifier.onAutoGateResolved!({ runId: "R1", reviewTaskId: "t" });
    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2835 (Codex convergence round 3) — the recommendation-hold pair.
//
// The host half of the fenced write. What is pinned HERE is the COMPOSITION: the
// park-owned fence reaches the writer intact, the row carries the park id that
// makes the clear addressable, and the clear's ack is honest. That the fence is
// ENFORCED is a property of Postgres, and is pinned against a real one in
// packages/agents/src/__tests__/recommendation-hold.integration.test.ts — a mock
// cannot fail a row lock, so nothing here pretends otherwise.
// ---------------------------------------------------------------------------
describe("runWaitNotifier.onEnterRecommendationHold — the fenced write", () => {
  it("passes the park-owned FENCE through to the writer, park id and all", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: "Nightly sync", status: "pending_input" });
    await runWaitNotifier.onEnterRecommendationHold!({ runId: "R1", parkId: "park-7" });

    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    // Through `unknown`: this is the one call site that passes a THIRD argument
    // (the fence options), and the shared mock above is declared with the two
    // parameters every other caller uses — so its `mock.calls` tuple is shorter
    // than what this assertion reads.
    const [recipient, input, options] = createNotificationForRecipient.mock.calls[0] as unknown as [
      { kind: string; userId: string },
      { title: string; href?: string; metadata?: Record<string, unknown> },
      { recipientUserIds?: string[]; fence?: { values: unknown[]; precondition: string; after?: string[] } },
    ];
    expect(recipient).toEqual({ kind: "user", userId: "user-1" });
    // The precondition names THIS park and THIS run, and takes the row lock. The
    // host does not re-spell it — it comes from the package that owns the table.
    expect(options.fence?.values).toEqual(["park-7", "R1", "recommendation"]);
    expect(options.fence?.precondition).toContain("FOR UPDATE");
    expect(options.fence?.precondition).toContain("lifecycle_continuation_park");
    // ...and the obligation mark rides the same statement, GATED on the insert's
    // own RETURNING (cinatra#2838) — a mark that merely followed the insert would
    // record `live` for an insert that no-opped on the dedupe conflict.
    expect(options.fence?.after?.[0]).toContain("hold_notification = 'live'");
    expect(options.fence?.after?.[0]).toContain(
      'EXISTS (SELECT 1 FROM "notification_write")',
    );
    // A single, already-resolved recipient: one lock, one insert.
    expect(options.recipientUserIds).toEqual(["user-1"]);
    // The row carries the park id, which is what makes the clear addressable.
    expect(input.metadata?.runAwaitingHuman).toMatchObject({
      runId: "R1",
      reason: "pending_input",
      holdParkId: "park-7",
    });
  });

  it("is the INPUT wait, landing on the conversation the run was started in", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: "Nightly sync", status: "pending_input" });
    findChatConversationPathForAgentRun.mockReturnValue("/chat/thread-9");
    await runWaitNotifier.onEnterRecommendationHold!({ runId: "R1", parkId: "park-7" });
    const [, input] = createNotificationForRecipient.mock.calls[0] as [unknown, { title: string; href?: string }];
    // The #2729 ruling: a held run has no HITL interrupt to classify, so this
    // seam states the input classification and gets the conversation link.
    expect(input.title).toBe('"Nightly sync" needs your input');
    expect(input.href).toBe("/chat/thread-9");
  });

  it("falls back to the run page when no conversation resolves", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "pending_input" });
    findChatConversationPathForAgentRun.mockImplementation(() => {
      throw new Error("thread store down");
    });
    await runWaitNotifier.onEnterRecommendationHold!({ runId: "R1", parkId: "park-7" });
    const [, input] = createNotificationForRecipient.mock.calls[0] as [unknown, { href?: string }];
    expect(input.href).toBe("/agents/acme/sales/R1");
  });

  it("no initiator ⇒ nothing written, so the park is never marked as owing a clear", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: null, title: null, status: "pending_input" });
    await runWaitNotifier.onEnterRecommendationHold!({ runId: "R1", parkId: "park-7" });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("a write failure never throws into the hold", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "pending_input" });
    createNotificationForRecipient.mockRejectedValueOnce(new Error("notifications down"));
    await expect(
      runWaitNotifier.onEnterRecommendationHold!({ runId: "R1", parkId: "park-7" }),
    ).resolves.toBeUndefined();
  });
});

describe("runWaitNotifier.onClearRecommendationHold — the ack", () => {
  it("deletes the row for THIS park under the run's key, and acks", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "pending_input" });
    await expect(
      runWaitNotifier.onClearRecommendationHold!({ runId: "R1", parkId: "park-7" }),
    ).resolves.toBe(true);
    expect(deleteHoldNotificationForUserAsync).toHaveBeenCalledWith({
      userId: "user-1",
      dedupeKey: "run-awaiting-human:R1",
      // Without this the clear would delete whatever wait currently holds the
      // run's key — including one this hold never wrote.
      holdParkId: "park-7",
    });
    // Never the unscoped delete: that one is the status-transition path's — which
    // since cinatra#2882 reaches it under its ASYNC name, so that is the name this
    // arm has to watch. The assertion is #2838's unchanged: a hold clear that fell
    // through to the per-run key would delete a wait it never wrote.
    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
  });

  it("a FAILING delete reports false — the obligation stays with the park", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "pending_input" });
    // cinatra#2882 — a REJECTION now, where the sync twin threw. This arm carries
    // a second load because of that: the handler has to `return await`, since a
    // bare `return` of the seam's promise would settle this async function WITH
    // it and route the rejection AROUND the catch. Drop the `await` and this
    // expectation rejects instead of resolving to `false`.
    deleteHoldNotificationForUserAsync.mockRejectedValue(new Error("notifications down"));
    await expect(
      runWaitNotifier.onClearRecommendationHold!({ runId: "R1", parkId: "park-7" }),
    ).resolves.toBe(false);
  });

  it("does not ack until the delete has actually settled", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", runBy: "user-1", title: null, status: "pending_input" });
    // The ack is "the statement COMMITTED", and the sweeper retires the park's
    // obligation on it. An ack handed over while the delete is still in flight
    // would retire an obligation that may still fail — and the retry that failure
    // is supposed to earn would be gone. So the `true` must come from AFTER the
    // await, never from beside it.
    let releaseDelete: (() => void) | undefined;
    deleteHoldNotificationForUserAsync.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseDelete = () => resolve(true);
      }),
    );
    let acked: boolean | undefined;
    // `Promise.resolve(...)` because the seam's declared return is
    // `boolean | Promise<boolean>` — the interface still admits a synchronous
    // host. This implementation is the async one; wrapping just types the await.
    const pending = Promise.resolve(
      runWaitNotifier.onClearRecommendationHold!({ runId: "R1", parkId: "park-7" }),
    ).then((value) => {
      acked = value;
    });
    // Drain everything the event loop has EXCEPT the delete itself.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteHoldNotificationForUserAsync).toHaveBeenCalledTimes(1);
    expect(acked).toBeUndefined();
    releaseDelete!();
    await pending;
    expect(acked).toBe(true);
  });

  it("an unreadable run retires the obligation rather than spinning on it forever", async () => {
    // The enter writes only for a resolvable initiator, so a park marked `live`
    // always had one. An unreadable run here is a purged run: the row is no longer
    // addressable, and retrying every sweep would never make it so.
    readAgentRunById.mockResolvedValue(null);
    await expect(
      runWaitNotifier.onClearRecommendationHold!({ runId: "R1", parkId: "park-7" }),
    ).resolves.toBe(true);
    expect(deleteHoldNotificationForUserAsync).not.toHaveBeenCalled();
  });
});
