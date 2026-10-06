import { declaredReviewPlan } from "@/lib/artifacts/artifact-review-target";
import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#1796 (epic #1620 S13) — the resume-delivery worker.
//
// Drains claimPendingResumeIntents → delivers the typed approve/reject payload to
// the paused WayFlow run via the A2A resume → markResumeIntentDelivered. Proves:
// the happy-path delivery, reject-never-reads-as-approval, the idempotent
// already-advanced short-circuit (no double-resume), the multi-gate advance
// guard, the retryable/lease-lost outcomes, and the sweep tally.

import {
  buildReviewApproveEnvelope,
  buildReviewRejectEnvelope,
  payloadAssertsApproval,
} from "@/lib/artifacts/artifact-review-rejection";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  // #1193: each resume leg mints + records its own per-run credential before the
  // blocking sendTask. Recording is ADDITIVE (earlier legs stay valid).
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
}));
vi.mock("../store", () => storeMock);

// cinatra#3007 — the executor asks the produced-review question before every
// terminal write. This suite is about the resume-outbox delivery sweep, drives the tail with no
// database, and would otherwise exercise the hold's FAIL-CLOSED branch (an
// unreachable store cannot prove the run owes no review, so no terminal status
// is written). Mocked inert here — "nothing holds this run" — so the tail under
// test behaves exactly as it did. The hold itself is proven in
// `execution-review-precedes-terminal.test.ts` (the wiring) and
// `produced-review-ordering.integration.test.ts` (the ordering, real store).
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: vi.fn(async () => ({
    held: false,
    reason: "no-produced-output",
  })),
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));
// cinatra#2485 C: the delivery now rechecks the agent's install scope at SEND
// time (the intent's own authorization is as old as the intent). The gate reads
// agent_runs / agent_templates straight from the DB; this suite mocks the
// persistence hub, so it mocks the gate too. Its behavior lives in
// `agent-template-scope.test.ts` / `agent-run-scope-guard.test.ts`; its presence
// at THIS call site is pinned by `agent-run-scope-enforcement-wiring.test.ts`.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));


vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));

const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(),
  listReviewGatesForRun: vi.fn<(runId: string) => Promise<Array<{ runId?: string; orgId?: string; reviewTaskId: string; status: string; pinnedTargets?: unknown }>>>(async () => []),
  markResumeIntentDelivered: vi.fn(),
}));
vi.mock("../artifact-review-gate-store", () => gateStoreMock);

const { sendTaskSpy, handleWayflowTaskStateSpy, resolveRunIdSpy, resolveLatestSpy } = vi.hoisted(
  () => ({
    sendTaskSpy: vi.fn(async (_req: unknown) => ({ id: "task-x", status: { state: "completed" } })),
    handleWayflowTaskStateSpy: vi.fn(async () => undefined),
    resolveRunIdSpy: vi.fn(async (_taskId: string): Promise<string | null> => null),
    resolveLatestSpy: vi.fn(async (_runId: string): Promise<string | null> => "task-1"),
  }),
);
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
  resolveRunIdByWayflowTaskId: resolveRunIdSpy,
  resolveLatestWayflowGateTaskId: resolveLatestSpy,
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: handleWayflowTaskStateSpy }));

import {
  deliverArtifactReviewResumeIntent,
  sweepArtifactReviewResumeIntents,
} from "../artifact-review-resume-delivery";
import type { ResumeIntentRow } from "../artifact-review-gate-store";

function pausedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tmpl-1",
    status: "pending_approval",
    a2aTaskId: "task-1",
    a2aContextId: "ctx-1",
    orgId: "org-1",
    ...overrides,
  };
}
function internalTemplate() {
  return { id: "tmpl-1", packageName: "@cinatra-ai/web-research-agent", sourceType: "internal" };
}

function intent(overrides: Partial<ResumeIntentRow> = {}): ResumeIntentRow {
  return {
    gateId: "gate-1",
    runId: "run-1",
    reviewTaskId: "wayflow-task-1",
    kind: "approve",
    responseText: JSON.stringify(
      buildReviewApproveEnvelope({ reviewTaskId: "wayflow-task-1", comment: null, targets: [] }),
    ),
    status: "delivering",
    attempts: 1,
    leaseToken: "lease-abc",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const PAUSE_TARGETS = [{ artifactId: "post", representationRevisionId: "r1" }, { artifactId: "image", representationRevisionId: "r2" }];
function familyRows(statuses: string[] = ["resolved", "resolved"]) {
  const plan = declaredReviewPlan({ runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-1", targets: PAUSE_TARGETS })!;
  return plan.legs.map((leg, i) => ({ runId: "run-1", orgId: "org-1", reviewTaskId: leg.reviewTaskId,
    status: statuses[i], pinnedTargets: [{ ...leg.targets[0], declaredReviewPlan: plan }] }));
}
function legacyRow() { return { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-1", status: "resolved", pinnedTargets: [PAUSE_TARGETS[0]] }; }

describe("cinatra#1796 — artifact-review resume-delivery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue(internalTemplate());
    gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([legacyRow()]);
    sendTaskSpy.mockResolvedValue({ id: "task-x", status: { state: "completed" } });
    handleWayflowTaskStateSpy.mockResolvedValue(undefined);
    // Default: the run's authoritative latest gate task IS this gate → deliver.
    resolveLatestSpy.mockResolvedValue("task-1");
    resolveRunIdSpy.mockResolvedValue(null);
  });

  it("delivers an approve resume into the paused run's a2aContextId, then marks it done", async () => {
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("delivered");

    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    const sent = sendTaskSpy.mock.calls[0]![0] as {
      message: { contextId: string; parts: Array<{ text: string }> };
    };
    expect(sent.message.contextId).toBe("ctx-1");
    const deliveredText = sent.message.parts[0]!.text;
    expect(payloadAssertsApproval(JSON.parse(deliveredText))).toBe(true);

    expect(handleWayflowTaskStateSpy).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
  });

  it("resolves a suffixed artifact leg through its original paused task", async () => {
    storeMock.readAgentRunByTaskId.mockImplementation(async (taskId: string) =>
      taskId === "task-1" ? pausedRun() : null,
    );
    const responseText = JSON.stringify(buildReviewApproveEnvelope({
      reviewTaskId: "wayflow-task-1#2", comment: null, targets: [],
    }));
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(familyRows());
    const outcome = await deliverArtifactReviewResumeIntent(intent({
      reviewTaskId: "wayflow-task-1#2", responseText,
    }));
    expect(outcome).toBe("delivered");
    expect(storeMock.readAgentRunByTaskId).toHaveBeenCalledWith("task-1");
    const sent = sendTaskSpy.mock.calls[0]![0] as { message: { parts: Array<{ text: string }> } };
    expect(sent.message.parts[0]!.text).toBe(responseText);
  });

  it("keeps the original pause parked while another artifact leg is pending", async () => {
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      ...familyRows(["resolved", "pending"]),
    ]);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
  });

  it("does not let another pause's pending leg hold this original task", async () => {
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      ...familyRows(),
      { reviewTaskId: "wayflow-task-2#2", status: "pending" },
    ]);
    const outcome = await deliverArtifactReviewResumeIntent(intent({ reviewTaskId: "wayflow-task-1#2" }));
    expect(outcome).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    expect(storeMock.readAgentRunByTaskId).toHaveBeenCalledWith("task-1");
  });

  it("retains dispatch authorization before acknowledging a pending sibling hold", async () => {
    const { assertAgentRunDispatchAuthorized } = await import("../agent-run-serde");
    vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(new Error("unreadable scope"));
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      { reviewTaskId: "wayflow-task-1#2", status: "pending" },
    ]);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("REJECT never reads as approval — the reject envelope travels the wire verbatim", async () => {
    const rejectText = JSON.stringify(
      buildReviewRejectEnvelope({ reviewTaskId: "wayflow-task-1", comment: "no", targets: [] }),
    );
    const outcome = await deliverArtifactReviewResumeIntent(
      intent({ kind: "reject", responseText: rejectText }),
    );
    expect(outcome).toBe("delivered");

    const sent = sendTaskSpy.mock.calls[0]![0] as { message: { parts: Array<{ text: string }> } };
    const delivered = JSON.parse(sent.message.parts[0]!.text) as Record<string, unknown>;
    // Structurally distinct: no `approved` key, review.decision === "rejected".
    expect(payloadAssertsApproval(delivered)).toBe(false);
    expect((delivered as { approved?: unknown }).approved).toBeUndefined();
    expect((delivered as { review: { decision: string } }).review.decision).toBe("rejected");
  });

  it("is idempotent: a run that already left pending_approval is marked done WITHOUT re-sending", async () => {
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "completed" }));
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
  });

  it("does not double-resume a multi-gate run advanced to a later gate (authoritative latest-task map)", async () => {
    // The run is still pending_approval, but the AUTHORITATIVE Redis latest-task
    // map says the run is now paused at a LATER gate → this gate's resume already
    // landed → mark done without re-sending (never trusts the stale a2a_task_id
    // column).
    storeMock.readAgentRunByTaskId.mockResolvedValue(
      pausedRun({ status: "pending_approval", a2aTaskId: "task-1" }),
    );
    resolveLatestSpy.mockResolvedValue("task-2-later");
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalled();
  });

  it("delivers when the latest-task map has lapsed (null → best-effort, run still pending here)", async () => {
    resolveLatestSpy.mockResolvedValue(null);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the intent pending (retryable) when the run is not resolvable yet", async () => {
    storeMock.readAgentRunByTaskId.mockResolvedValue(null);
    resolveRunIdSpy.mockResolvedValue(null);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("recovers the run via the Redis reverse-map when the a2a_task_id column is stale", async () => {
    storeMock.readAgentRunByTaskId.mockResolvedValue(null);
    resolveRunIdSpy.mockResolvedValue("run-1");
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("reports lease-lost when a stale worker's mark loses the lease race (no double-mark)", async () => {
    gateStoreMock.markResumeIntentDelivered.mockResolvedValue(false);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("lease-lost");
    // The send still happened (at-least-once); only the mark lost the race.
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("sweep drains the claimed batch and tallies outcomes", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([
      intent({ gateId: "g-a", reviewTaskId: "wayflow-task-1" }),
      intent({ gateId: "g-b", reviewTaskId: "wayflow-task-1" }),
    ]);
    // First delivers; second finds the run already advanced.
    storeMock.readAgentRunByTaskId
      .mockResolvedValueOnce(pausedRun())
      .mockResolvedValueOnce(pausedRun({ status: "completed" }));

    const summary = await sweepArtifactReviewResumeIntents();
    expect(summary.attempted).toBe(2);
    expect(summary.delivered).toBe(1);
    expect(summary.alreadyAdvanced).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("a per-intent throw is tallied as failed and never poisons the batch", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([intent()]);
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "external", // violates the internal-template invariant → throws
    });
    const summary = await sweepArtifactReviewResumeIntents();
    expect(summary.attempted).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.delivered).toBe(0);
  });
  it("App160: a failed gate-list read sends and acknowledges nothing, then the existing intent retries", async () => {
    const failure = new Error("existing sibling inventory unavailable");
    const currentIntent = intent();
    const before = JSON.stringify(currentIntent);
    gateStoreMock.listReviewGatesForRun.mockRejectedValueOnce(failure);
    await expect(deliverArtifactReviewResumeIntent(currentIntent)).rejects.toBe(failure);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    expect(JSON.stringify(currentIntent)).toBe(before);
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([legacyRow()]);
    await expect(deliverArtifactReviewResumeIntent(currentIntent)).resolves.toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledTimes(1);
  });
  it("REVIEW completeness: an original singleton must not resume after a second required leg failed to mint", async () => {
    // execution.ts's partial-mint branch leaves just this gate when the next
    // required emit refuses (the authored marked-gate test proves that state).
    // After its decision, no pending row represents the still-unreviewed second
    // target; a successful list read must not prove the whole pause complete.
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      { reviewTaskId: "wayflow-task-1", status: "resolved" },
    ]);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    expect(outcome).toBe("retryable");
  });

  it.each(["missing", "resolved-mismatch", "missing-witness", "malformed-witness", "foreign", "wrong-run"])("H1: %s family sends and acknowledges nothing", async corruption => {
    const rows = familyRows();
    if (corruption === "missing") rows.pop();
    if (corruption === "resolved-mismatch") rows[1].pinnedTargets[0].representationRevisionId = "different";
    if (corruption === "missing-witness") delete (rows[1].pinnedTargets[0] as { declaredReviewPlan?: unknown }).declaredReviewPlan;
    if (corruption === "malformed-witness") Object.assign(rows[1].pinnedTargets[0], { declaredReviewPlan: {} });
    if (corruption === "foreign") rows[1].orgId = "other";
    if (corruption === "wrong-run") rows[1].runId = "other";
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(familyRows());
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "completed" }));
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("already-advanced");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
  it("keeps a legitimate historical combined gate drain unchanged", async () => {
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([{ ...legacyRow(), pinnedTargets: PAUSE_TARGETS }]);
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

});
