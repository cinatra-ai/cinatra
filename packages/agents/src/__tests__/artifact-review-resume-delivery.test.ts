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
  // cinatra#3745: the claim read, the lease renewal and the task record.
  readResumeIntentClaim: vi.fn<(gateId: string, leaseToken: string) => Promise<{ runClaimed: boolean; result: unknown } | null>>(),
  renewResumeIntentLease: vi.fn<(gateId: string, leaseToken: string, leaseMs: number) => Promise<boolean>>(),
  recordResumeTaskResult: vi.fn<(gateId: string, leaseToken: string, task: unknown) => Promise<boolean>>(),
  // cinatra#3745: another driver holds the run with no witness yet; the intent waits for a later lease.
  deferResumeIntent: vi.fn<(gateId: string, leaseToken: string) => Promise<boolean>>(),
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
// cinatra#3745: the delivery claims the run (pending_approval -> running) before it
// sends, so the resumed leg's callbacks find the run running. The claim against a
// real database is proven in `resume-legs-run-source-3745.integration.test.ts`.
const claimSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("../run-transition", () => ({ transitionRunStatus: claimSpy }));

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
    runClaimedAt: null,
    resumeTaskResult: null,
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
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: false, result: null });
    gateStoreMock.renewResumeIntentLease.mockResolvedValue(true);
    gateStoreMock.recordResumeTaskResult.mockResolvedValue(true);
    gateStoreMock.deferResumeIntent.mockResolvedValue(true);
    claimSpy.mockImplementation(async () => undefined);
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

  it("cinatra#3745: claims the run running before it sends, and hands the handler the run where it is", async () => {
    const order: string[] = [];
    claimSpy.mockImplementation(async (...args: unknown[]) => { order.push(`${args[1]}->${args[2]}`); return undefined; });
    sendTaskSpy.mockImplementationOnce(async () => { order.push("send"); return { id: "task-x", status: { state: "completed" } }; });
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
    expect(order).toEqual(["pending_approval->running", "send"]);
    expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "running" }));
    claimSpy.mockImplementation(async () => undefined);
  });

  it("cinatra#3745: a failed send puts the gate back and leaves the intent pending", async () => {
    const order: string[] = [];
    claimSpy.mockImplementation(async (...args: unknown[]) => { order.push(`${args[1]}->${args[2]}`); return undefined; });
    sendTaskSpy.mockRejectedValueOnce(new Error("wayflow unreachable"));
    await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow("wayflow unreachable");
    expect(order).toEqual(["pending_approval->running", "running->pending_approval"]);
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    claimSpy.mockImplementation(async () => undefined);
  });

  it("D1 cinatra#3745: a lost claim sends nothing, closes nothing and leaves the intent for a later lease", async () => {
    // Another driver moved the run first. Its claim can still fail before its
    // dispatch and put the run back on this gate, so a lost claim is no witness.
    claimSpy.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    expect(gateStoreMock.deferResumeIntent).toHaveBeenCalledWith("gate-1", "lease-abc");
  });

  it("cinatra#3745: a claim that fails for any other reason sends nothing and leaves the intent pending", async () => {
    claimSpy.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow("db unavailable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
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

  it("sweep drains the claimed rows and tallies outcomes", async () => {
    gateStoreMock.claimPendingResumeIntents
      .mockResolvedValueOnce([intent({ gateId: "g-a", reviewTaskId: "wayflow-task-1" })])
      .mockResolvedValueOnce([intent({ gateId: "g-b", reviewTaskId: "wayflow-task-1" })]);
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
    gateStoreMock.claimPendingResumeIntents.mockResolvedValueOnce([intent()]);
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

  it("H2: the independent trailing malformed duplicate witness cannot authorize resume", async () => {
    const rows = familyRows();
    for (const row of rows) {
      const witness = row.pinnedTargets[0].declaredReviewPlan as unknown as { legs: unknown[] };
      witness.legs.push({ reviewTaskId: "wayflow-task-1#3", targets: [PAUSE_TARGETS[0]], unexpected: true });
    }
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("H2: raw duplicate pinned entries cannot impersonate one witnessed singleton", async () => {
    const rows = familyRows();
    rows[1].pinnedTargets.push({ ...rows[1].pinnedTargets[0] });
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });


  describe("cinatra#3745: the claim row decides, the lease is kept and fenced", () => {
    const edges = () => claimSpy.mock.calls.map((c) => `${c[1]}->${c[2]}`);
    const leaseOf = (call: unknown[]) => (call[3] as { resumeIntentLease?: unknown } | undefined)?.resumeIntentLease;

    it("every run edge the delivery writes carries its lease", async () => {
      sendTaskSpy.mockRejectedValueOnce(new Error("wayflow unreachable"));
      await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow("wayflow unreachable");
      expect(edges()).toEqual(["pending_approval->running", "running->pending_approval"]);
      for (const call of claimSpy.mock.calls) expect(leaseOf(call)).toEqual({ gateId: "gate-1", leaseToken: "lease-abc" });
    });

    it("a claimed run with nothing recorded is re-sent without a second claim (row 5)", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.recordResumeTaskResult).toHaveBeenCalledTimes(1);
    });

    it("a claimed run with a recorded task replays the handler and sends nothing (row 4)", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      const recorded = { id: "task-recorded", status: { state: "input-required" } };
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: recorded });
      resolveLatestSpy.mockResolvedValue("task-recorded");
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "running", task: recorded }));
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
    });

    it("D2 running with no mark and nothing recorded is another driver's hold: deferred, never closed or sent", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(gateStoreMock.deferResumeIntent).toHaveBeenCalledWith("gate-1", "lease-abc");
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    });

    it("D3 a deferral that finds its lease gone reports lease-lost and closes nothing", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.deferResumeIntent.mockResolvedValueOnce(false);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("D4 a lost scope-refusal CAS stamps no failure and closes nothing: the next lease reads the run again", async () => {
      const { assertAgentRunDispatchAuthorized } = await import("../agent-run-serde");
      vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(
        Object.assign(new Error("scope denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: "the owning team is gone" }));
      claimSpy.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(edges()).toEqual(["pending_approval->failed"]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(gateStoreMock.deferResumeIntent).toHaveBeenCalledWith("gate-1", "lease-abc");
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("running with no mark and a recorded task (delivered) and paused with a recorded task close without a send", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: false, result: { id: "t" } });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("already-advanced");
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: { id: "t" } });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("already-advanced");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    });

    it("a claimed run whose latest gate task is another is left for a later cycle (row 6)", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      resolveLatestSpy.mockResolvedValue("task-2-later");
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("an intent no longer under this lease does nothing", async () => {
      gateStoreMock.readResumeIntentClaim.mockResolvedValue(null);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("a refused fence sends, releases and closes nothing", async () => {
      gateStoreMock.renewResumeIntentLease.mockResolvedValue(false);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("a refused record runs no handler and closes nothing", async () => {
      gateStoreMock.recordResumeTaskResult.mockResolvedValue(false);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    // Fail-closed branches. Each case asserts what the delivery must not do: send,
    // run the handler or close the intent. A throw is settled into a value, so a
    // delivery that resolves instead of rejecting fails on an assertion.
    const settle = (p: Promise<unknown>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));
    const replayRow = () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      const recorded = { id: "task-recorded", status: { state: "input-required" } };
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: recorded });
    };

    it("F1 a refused renewal before the replay runs no handler and closes nothing", async () => {
      replayRow();
      gateStoreMock.renewResumeIntentLease.mockResolvedValue(false);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(gateStoreMock.renewResumeIntentLease).toHaveBeenCalledTimes(1);
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual([]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F2 a refused renewal after a recorded task runs no handler, releases nothing and closes nothing", async () => {
      gateStoreMock.renewResumeIntentLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.recordResumeTaskResult).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.renewResumeIntentLease).toHaveBeenCalledTimes(2);
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F3 a claim read that throws propagates: no claim, no send, intent not closed", async () => {
      const failure = new Error("claim read unavailable");
      gateStoreMock.readResumeIntentClaim.mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F4 a task record that throws propagates: no handler, no release, intent not closed", async () => {
      const failure = new Error("record unavailable");
      gateStoreMock.recordResumeTaskResult.mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F5 an awaited renewal that throws before the send propagates: no send, intent not closed", async () => {
      const failure = new Error("renewal unavailable");
      gateStoreMock.renewResumeIntentLease.mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F6 an awaited renewal that throws after the record propagates: no handler, intent not closed", async () => {
      const failure = new Error("renewal unavailable");
      gateStoreMock.renewResumeIntentLease.mockResolvedValueOnce(true).mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.recordResumeTaskResult).toHaveBeenCalledTimes(1);
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F7 an awaited renewal that throws before the replay propagates: no handler, intent not closed", async () => {
      replayRow();
      const failure = new Error("renewal unavailable");
      gateStoreMock.renewResumeIntentLease.mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual([]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("F8 a replay whose handler throws propagates: nothing sent, intent not closed", async () => {
      replayRow();
      const failure = new Error("handler failed");
      handleWayflowTaskStateSpy.mockRejectedValueOnce(failure);
      expect(await settle(deliverArtifactReviewResumeIntent(intent()))).toEqual({ error: failure });
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledTimes(1);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(edges()).toEqual([]);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("a lost lease on the release returns lease-lost; any other release error rethrows the send error", async () => {
      claimSpy.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "running") throw Object.assign(new Error("lease"), { code: "resume_intent_lease_lost" });
      });
      sendTaskSpy.mockRejectedValueOnce(new Error("wayflow unreachable"));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      claimSpy.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "running") throw Object.assign(new Error("stale"), { code: "stale_from_status" });
      });
      sendTaskSpy.mockRejectedValueOnce(new Error("wayflow unreachable"));
      await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow("wayflow unreachable");
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("a scope refusal fails the run from where this delivery holds it, under the lease", async () => {
      const { assertAgentRunDispatchAuthorized } = await import("../agent-run-serde");
      const denial = Object.assign(new Error("denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: "team gone" });
      vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(denial);
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("refused-out-of-scope");
      expect(edges()).toEqual(["running->failed"]);
      expect(leaseOf(claimSpy.mock.calls[0]!)).toEqual({ gateId: "gate-1", leaseToken: "lease-abc" });
      vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(denial);
      claimSpy.mockRejectedValueOnce(Object.assign(new Error("lease"), { code: "resume_intent_lease_lost" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledTimes(1);
    });

    it("the recorded task drops every key and value of the resume metadata", async () => {
      sendTaskSpy.mockImplementationOnce(async (req: unknown) => {
        const metadata = (req as { message: { metadata: Record<string, unknown> } }).message.metadata;
        return { id: "task-x", status: { state: "completed" }, history: [{ metadata, echo: Object.values(metadata)[0] }] };
      });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      const sent = sendTaskSpy.mock.calls[0]![0] as { message: { metadata: Record<string, unknown> } };
      const [key, value] = Object.entries(sent.message.metadata)[0]!;
      const stored = JSON.stringify(gateStoreMock.recordResumeTaskResult.mock.calls[0]![2]);
      expect(stored).toContain("task-x");
      expect(stored).not.toContain(key);
      expect(stored).not.toContain(String(value));
    });

    it("T7 the renewal timer renews every third of the lease and is cleared on every exit", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        let release!: () => void;
        sendTaskSpy.mockImplementationOnce(() => new Promise((res) => {
          release = () => res({ id: "task-x", status: { state: "completed" } });
        }));
        const pending = deliverArtifactReviewResumeIntent(intent(), { leaseMs: 3000 });
        await vi.waitFor(() => expect(sendTaskSpy).toHaveBeenCalledTimes(1));
        const before = gateStoreMock.renewResumeIntentLease.mock.calls.length;
        vi.advanceTimersByTime(3000);
        expect(gateStoreMock.renewResumeIntentLease.mock.calls.length - before).toBe(3);
        expect(gateStoreMock.renewResumeIntentLease).toHaveBeenCalledWith("gate-1", "lease-abc", 3000);
        release();
        expect(await pending).toBe("delivered");
        expect(vi.getTimerCount()).toBe(0);
        // send error, lease-lost, scope refusal, refused renewal: each exit clears it too.
        sendTaskSpy.mockRejectedValueOnce(new Error("wayflow unreachable"));
        await expect(deliverArtifactReviewResumeIntent(intent())).rejects.toThrow();
        expect(vi.getTimerCount()).toBe(0);
        gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(null);
        expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
        expect(vi.getTimerCount()).toBe(0);
        const { assertAgentRunDispatchAuthorized } = await import("../agent-run-serde");
        vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(
          Object.assign(new Error("denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: "team gone" }));
        expect(await deliverArtifactReviewResumeIntent(intent())).toBe("refused-out-of-scope");
        expect(vi.getTimerCount()).toBe(0);
        gateStoreMock.renewResumeIntentLease.mockResolvedValueOnce(false);
        expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("T7 a renewal that throws is logged and retried; a refused one stops the timer", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        let release!: () => void;
        sendTaskSpy.mockImplementationOnce(() => new Promise((res) => {
          release = () => res({ id: "task-x", status: { state: "completed" } });
        }));
        const pending = deliverArtifactReviewResumeIntent(intent(), { leaseMs: 3000 });
        await vi.waitFor(() => expect(sendTaskSpy).toHaveBeenCalledTimes(1));
        gateStoreMock.renewResumeIntentLease.mockRejectedValueOnce(Object.assign(new Error("secret-bearing text"), { code: "57P01" }));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.advanceTimersByTime(1000);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(String(warn.mock.calls[0]![0])).toContain("57P01");
        expect(String(warn.mock.calls[0]![0])).not.toContain("secret-bearing text");
        warn.mockRestore();
        gateStoreMock.renewResumeIntentLease.mockResolvedValueOnce(false);
        vi.advanceTimersByTime(1000);
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
        release();
        expect(await pending).toBe("lease-lost");
      } finally {
        vi.useRealTimers();
      }
    });

    it("T7 the sweep claims one row at a time with its lease, and stops at the first empty claim", async () => {
      gateStoreMock.claimPendingResumeIntents.mockResolvedValueOnce([intent({ gateId: "g-a" })]);
      const summary = await sweepArtifactReviewResumeIntents({ limit: 3, leaseMs: 9000 });
      expect(summary.attempted).toBe(1);
      expect(gateStoreMock.claimPendingResumeIntents.mock.calls).toEqual([[{ limit: 1, leaseMs: 9000 }], [{ limit: 1, leaseMs: 9000 }]]);
      expect(gateStoreMock.renewResumeIntentLease).toHaveBeenCalledWith("g-a", "lease-abc", 9000);
    });
  });
});
