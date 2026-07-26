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
  readAgentTemplateById: vi.fn(),
}));
vi.mock("../store", () => storeMock);

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));

const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(),
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
  return { id: "tmpl-1", packageName: "@cinatra-ai/reviewer-agent", sourceType: "internal" };
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

describe("cinatra#1796 — artifact-review resume-delivery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue(internalTemplate());
    gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
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
      packageName: "@cinatra-ai/reviewer-agent",
      sourceType: "external", // violates the internal-template invariant → throws
    });
    const summary = await sweepArtifactReviewResumeIntents();
    expect(summary.attempted).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.delivered).toBe(0);
  });
});
