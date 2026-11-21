import { declaredReviewPlan } from "@/lib/artifacts/artifact-review-target";
import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#4150: every resume road reads the run's newest publish decision before it
// sends. This suite is about another question, so no publish decision holds its run.
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));

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
  // cinatra#3745: a run found through the reverse map with no gate task gets this
  // gate's task under the pause claim, before the fence.
  updateAgentRunA2ATaskId: vi.fn(async (..._args: unknown[]) => ({ written: true })),
}));
vi.mock("../store", () => storeMock);
// cinatra#4245: the worker's claim always wins here; its refusals have their own
// test (artifact-review-resume-delivery-claim.test.ts).
vi.mock("../run-pause-claim", () => ({
  claimPause: vi.fn(async () => ({ kind: "claimed", token: "tok", generation: 1, expiresAt: new Date(0) })),
  fencePauseInPlace: vi.fn(async () => "fenced"),
  releasePauseClaim: vi.fn(async () => "released"),
  settlePauseSend: vi.fn(async () => "settled"),
  PauseClaimReleaseError: class extends Error {},
}));

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

// cinatra#4312 — the run decision lock's transaction, as the lock hands it to the
// re-read and the acknowledgement it guards.
const TX = vi.hoisted(() => ({ tx: "run-decision-lock" }));
const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(),
  listReviewGatesForRun: vi.fn<(runId: string, executor?: unknown) => Promise<Array<{ runId?: string; orgId?: string; reviewTaskId: string; status: string; pinnedTargets?: unknown; createdAt?: Date }>>>(async () => []),
  markResumeIntentDelivered: vi.fn(),
  withRunDecisionLock: vi.fn(async (_runId: string, fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
  deadLetterExhaustedResumeIntents: vi.fn(async () => 0),
  // cinatra#3745: the claim read, the lease renewal and the task record.
  readResumeIntentClaim: vi.fn<(gateId: string, leaseToken: string) => Promise<{ runClaimed: boolean; result: unknown } | null>>(),
  renewResumeIntentLease: vi.fn<(gateId: string, leaseToken: string, leaseMs: number) => Promise<boolean>>(),
  recordResumeTaskResult: vi.fn<(gateId: string, leaseToken: string, task: unknown) => Promise<boolean>>(),
  // cinatra#3745: another driver holds the run with no witness yet; the intent waits for a later lease.
  deferResumeIntent: vi.fn<(gateId: string, leaseToken: string) => Promise<boolean>>(),
  // cinatra#3745: the settle of a claimed intent that used its attempts.
  leaseExhaustedResumeClaims: vi.fn<(opts?: unknown) => Promise<unknown[]>>(async () => []),
  deadLetterResumeIntentUnderLease: vi.fn<(gateId: string, leaseToken: string, lastError: string) => Promise<boolean>>(async () => true),
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
// cinatra#4312 — the repair-lineage reads the worker takes for a Regenerate on a
// declared picture leg. Real-store proofs: lifecycle-c-w11-picture-regenerate-parks-run-3035.integration.test.ts.
const lineageStateError = (code: string) => Object.assign(new Error(`${code}: lineage state`), { name: "RepairLineageStateError", code });
const repairStoreMock = vi.hoisted(() => ({
  readRepairLineageRootGate: vi.fn<(taskId: string, gateId: string) => Promise<unknown>>(async () => {
    throw Object.assign(new Error("unknown-repair: not seeded"), { name: "RepairLineageStateError", code: "unknown-repair" });
  }),
  isRepairLineageOpen: vi.fn<(gateId: string, executor?: unknown) => Promise<boolean>>(async () => false),
}));
vi.mock("../lifecycle-repair-store", () => repairStoreMock);
// cinatra#4476 — the upgrade recovery the sweep runs before its claim. Real-store
// proofs: resume-upgrade-recovery-4476.integration.test.ts.
const recoveryMock = vi.hoisted(() => ({
  recoverStrandedDeclaredReviews: vi.fn<() => Promise<unknown[]>>(async () => []),
}));
vi.mock("../declared-review-recovery", () => recoveryMock);
// cinatra#3745: the delivery claims the run (pending_approval -> running) before it
// sends, so the resumed leg's callbacks find the run running. The claim against a
// real database is proven in `resume-delivery-claim-3745.integration.test.ts`.
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
    gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValue([]);
    gateStoreMock.deadLetterResumeIntentUnderLease.mockResolvedValue(true);
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
    // cinatra#4245: the claim edge is the pause fence, and the intent's lease rides on it.
    expect(claimSpy.mock.calls[0]![3]).toEqual({
      pauseFence: { token: "tok", generation: 1 },
      resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-abc" },
      // cinatra#3745: the fence is bound to the gate it read, as on the MCP resume,
      // and refuses, in its own transaction, a claim that would clear a
      // produced-review park (S4).
      resumeGate: { a2aTaskId: "task-1", executionAttemptId: null, onParkCleared: expect.any(Function) },
    });
    expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({
      fromStatus: "running", pauseClaimToken: "tok", claimedGate: { a2aTaskId: "task-1", executionAttemptId: null },
    }));
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

  // cinatra#3745 S4: a run parked on its produced output's review has reached its
  // terminal write (the park withholds it), so its WayFlow work is done. A claim
  // that cleared the park and then went back on the gate (a failed send, or a
  // later lease's or the settle's release after the worker died) would leave the
  // run pending_approval with neither the park nor its withheld terminal write.
  // The mock stands in for the real transition: the claim clears the park and
  // hands it to onParkCleared inside the claim's transaction; a throw there rolls
  // the claim back and reaches the caller.
  const S4_PARK = { producedReviewPark: '{"status":"completed"}', withheldTerminal: { status: "completed" } };
  const claimClearsPark = () => claimSpy.mockImplementation(async (...args: unknown[]) => {
    const meta = args[3] as { resumeGate?: { onParkCleared?: (park: unknown) => void } } | undefined;
    if (args[1] === "pending_approval" && args[2] === "running") meta?.resumeGate?.onParkCleared?.(S4_PARK);
    return undefined;
  });

  it("S4 cinatra#3745: a claim that would clear a produced-review park is refused in its transaction: the pause claim is given back, nothing is sent and the intent closes", async () => {
    const { releasePauseClaim } = await import("../run-pause-claim");
    claimClearsPark();
    expect(await deliverArtifactReviewResumeIntent(intent())).toBe("already-advanced");
    expect(claimSpy.mock.calls.map((c) => `${c[1]}->${c[2]}`)).toEqual(["pending_approval->running"]);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(releasePauseClaim).toHaveBeenCalledWith({ runId: "run-1", orgId: "org-1", token: "tok" }, expect.anything());
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
    expect(gateStoreMock.deferResumeIntent).not.toHaveBeenCalled();
  });

  it("S4 cinatra#3745: the refused claim of a parked run closes the intent even when the pause claim cannot be given back", async () => {
    const { releasePauseClaim } = await import("../run-pause-claim");
    vi.mocked(releasePauseClaim).mockRejectedValueOnce(Object.assign(new Error("db blip"), { code: "57P01" }));
    claimClearsPark();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("already-advanced");
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
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
    // cinatra#4312 — acknowledged under the run decision lock, after a re-read there.
    expect(gateStoreMock.withRunDecisionLock).toHaveBeenCalledWith("run-1", expect.any(Function));
    expect(gateStoreMock.listReviewGatesForRun).toHaveBeenCalledWith("run-1", TX);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc", TX);
  });

  it("does not let another pause's pending leg hold this original task", async () => {
    // cinatra#4312 — the other pause is an OLDER one: a later pause would close this
    // decision without a send (`laterDeclaredPause`), and so would a gate whose time
    // cannot be read, so every gate here carries its created time.
    const at = new Date("2026-11-03T12:00:00Z");
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      ...familyRows().map((row) => ({ ...row, createdAt: at })),
      { reviewTaskId: "wayflow-task-2#2", status: "pending", createdAt: new Date(at.getTime() - 1) },
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

  it("cinatra#4312: the sweep dead-letters exhausted intents before it claims", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    await sweepArtifactReviewResumeIntents();
    expect(gateStoreMock.deadLetterExhaustedResumeIntents).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.deadLetterExhaustedResumeIntents.mock.invocationCallOrder[0])
      .toBeLessThan(gateStoreMock.claimPendingResumeIntents.mock.invocationCallOrder[0]);
  });

  describe("cinatra#3745: the settle of a claimed intent that used its attempts", () => {
    const exhausted = () => intent({ attempts: 20, finalAttempt: true, leaseToken: "lease-settle", runClaimedAt: new Date() });
    const runningRun = () => pausedRun({ status: "running", executionAttemptId: "attempt-A" });

    it("S1 a claim that died at the last attempt: the next sweep puts the run back on its gate, then dead-letters the intent", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
      const summary = await sweepArtifactReviewResumeIntents();
      expect(summary.failed).toBe(0);
      expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1");
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]!.slice(0, 3)).toEqual(["run-1", "running", "pending_approval"]);
      expect(claimSpy.mock.calls[0]![3]).toMatchObject({
        resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-settle" },
        resumeGate: { a2aTaskId: "task-1", executionAttemptId: "attempt-A" },
      });
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
      expect(claimSpy.mock.invocationCallOrder[0]).toBeLessThan(gateStoreMock.deadLetterResumeIntentUnderLease.mock.invocationCallOrder[0]!);
      // The settle runs before the dead-letter pass, which leaves a claimed intent out.
      expect(gateStoreMock.leaseExhaustedResumeClaims.mock.invocationCallOrder[0])
        .toBeLessThan(gateStoreMock.deadLetterExhaustedResumeIntents.mock.invocationCallOrder[0]!);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    });

    // A settle never closes or dead-letters an intent while its run is still
    // `running` under the claim mark: no driver would take that run, and the
    // upgrade recovery reads only paused runs.
    const recorded = { runClaimed: true, result: { id: "task-recorded" } };
    it("S2 a settle of a recorded task renews its lease, replays the handler from the record, bound to the run's gate, sends nothing and closes the intent once the run left running", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(pausedRun({ status: "completed" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce(recorded);
      const summary = await sweepArtifactReviewResumeIntents();
      expect(summary.failed).toBe(0);
      expect(gateStoreMock.renewResumeIntentLease).toHaveBeenCalledWith("gate-1", "lease-settle", expect.any(Number));
      expect(gateStoreMock.renewResumeIntentLease.mock.invocationCallOrder[0]).toBeLessThan(handleWayflowTaskStateSpy.mock.invocationCallOrder[0]!);
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledTimes(1);
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1", fromStatus: "running", task: { id: "task-recorded" },
        claimedGate: { a2aTaskId: "task-1", executionAttemptId: "attempt-A" },
      }));
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-settle");
      expect(claimSpy).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S2 a settle whose lease renewal is refused replays nothing and closes nothing", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded);
      gateStoreMock.renewResumeIntentLease.mockResolvedValueOnce(false);
      await sweepArtifactReviewResumeIntents();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S2 a settle whose replay throws after it bound the run puts the run back from a second read, then dead-letters the intent", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun())
        .mockResolvedValueOnce(pausedRun({ status: "running", executionAttemptId: "attempt-A", a2aTaskId: "task-bound" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce(recorded);
      handleWayflowTaskStateSpy.mockRejectedValueOnce(new Error("handler fault"));
      const summary = await sweepArtifactReviewResumeIntents();
      expect(summary.failed).toBe(0);
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]!.slice(0, 3)).toEqual(["run-1", "running", "pending_approval"]);
      expect(claimSpy.mock.calls[0]![3]).toMatchObject({
        resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-settle" },
        resumeGate: { a2aTaskId: "task-bound", executionAttemptId: "attempt-A" },
      });
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
      expect(claimSpy.mock.invocationCallOrder[0]).toBeLessThan(gateStoreMock.deadLetterResumeIntentUnderLease.mock.invocationCallOrder[0]!);
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("S2 a replay that returns while the run is still running under the mark (its gate binding refused) closes nothing: the run is put back, then the intent is dead-lettered", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce(recorded);
      await sweepArtifactReviewResumeIntents();
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]!.slice(0, 3)).toEqual(["run-1", "running", "pending_approval"]);
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
    });

    it("S2 a replay that returns while another driver holds the run (mark cleared) closes the intent and puts nothing back", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce({ runClaimed: false, result: { id: "task-recorded" } });
      await sweepArtifactReviewResumeIntents();
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-settle");
      expect(claimSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S2 a settle whose release moved nothing while the run is still running under the mark dead-letters nothing: a later settle reads it again", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null }).mockResolvedValueOnce({ runClaimed: true, result: null });
      claimSpy.mockImplementationOnce(async () => {
        throw Object.assign(new Error("stale"), { code: "stale_from_status" });
      });
      await sweepArtifactReviewResumeIntents();
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S2 a settle of a recorded task whose run names no gate task replays nothing unbound: the run goes back on the mark alone", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(pausedRun({ status: "running", executionAttemptId: "attempt-A", a2aTaskId: null }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: { id: "task-recorded" } });
      await sweepArtifactReviewResumeIntents();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]![3]).toEqual({ resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-settle" } });
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("S3 a settle whose release finds the mark cleared or the lease gone dead-letters nothing", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
      claimSpy.mockImplementationOnce(async () => {
        throw Object.assign(new Error("lease lost"), { code: "resume_intent_lease_lost" });
      });
      await sweepArtifactReviewResumeIntents();
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S4 a settle whose release fails otherwise leaves the intent for a later settle", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(runningRun());
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
      claimSpy.mockImplementationOnce(async () => {
        throw Object.assign(new Error("db blip"), { code: "ECONNRESET" });
      });
      await sweepArtifactReviewResumeIntents();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).not.toHaveBeenCalled();
    });

    it("S5 a settle whose run another driver ended puts nothing back and dead-letters the intent", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(pausedRun({ status: "stopped" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
      await sweepArtifactReviewResumeIntents();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
    });

    it("RED F5 S7 a settle of a claimed run that names no gate task puts it back on the mark alone, then dead-letters the intent", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
      storeMock.readAgentRunById.mockResolvedValueOnce(pausedRun({ status: "running", executionAttemptId: "attempt-A", a2aTaskId: null }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
      await sweepArtifactReviewResumeIntents();
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]!.slice(0, 3)).toEqual(["run-1", "running", "pending_approval"]);
      // The lease fence needs the mark, which every other driver's entry into running clears.
      expect(claimSpy.mock.calls[0]![3]).toEqual({ resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-settle" } });
      expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledWith("gate-1", "lease-settle", "resume delivery attempts exhausted");
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("S6 a failed settle pass is tallied and the dead-letter pass and the claim still run", async () => {
      gateStoreMock.leaseExhaustedResumeClaims.mockRejectedValueOnce(new Error("db blip"));
      gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
      expect((await sweepArtifactReviewResumeIntents()).failed).toBe(1);
      expect(gateStoreMock.deadLetterExhaustedResumeIntents).toHaveBeenCalledTimes(1);
      expect(gateStoreMock.claimPendingResumeIntents).toHaveBeenCalledTimes(1);
    });

    // The "Last error" column of the lifecycle-operations page draws the stored
    // lastError as it is. A settle stores the same fixed text the dead-letter
    // pass stores; the reason of each settle goes to the log only.
    const settleBranches: Array<{ name: string; why: string; arrange: () => void }> = [
      {
        name: "a run put back on its gate (nothing recorded)",
        why: "the run is back on its gate",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(runningRun());
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
        },
      },
      {
        name: "a replay that threw",
        why: "the replay of its recorded task threw",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce(recorded);
          handleWayflowTaskStateSpy.mockRejectedValueOnce(new Error("handler fault"));
        },
      },
      {
        name: "a replay that returned with the run still held",
        why: "its recorded task was replayed",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded).mockResolvedValueOnce(recorded);
        },
      },
      {
        name: "a recorded task whose run names no gate task",
        why: "its recorded task was not replayed",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(pausedRun({ status: "running", executionAttemptId: "attempt-A", a2aTaskId: null }));
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce(recorded);
        },
      },
      {
        name: "a release that moved nothing because the run left running",
        why: "the run left running (run stopped)",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(pausedRun({ status: "stopped" }));
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null }).mockResolvedValueOnce({ runClaimed: true, result: null });
          claimSpy.mockImplementationOnce(async () => {
            throw Object.assign(new Error("stale"), { code: "stale_from_status" });
          });
        },
      },
      {
        name: "a run another driver ended",
        why: "nothing of this gate to put back (run stopped)",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(pausedRun({ status: "stopped" }));
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
        },
      },
      {
        name: "a run that is gone",
        why: "the run is gone",
        arrange: () => {
          storeMock.readAgentRunById.mockResolvedValueOnce(null);
          gateStoreMock.readResumeIntentClaim.mockResolvedValueOnce({ runClaimed: true, result: null });
        },
      },
    ];
    for (const branch of settleBranches) {
      it(`P4b the settle of ${branch.name} stores only the fixed dead-letter text and logs its reason`, async () => {
        gateStoreMock.leaseExhaustedResumeClaims.mockResolvedValueOnce([exhausted()]);
        branch.arrange();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          await sweepArtifactReviewResumeIntents();
          expect(gateStoreMock.deadLetterResumeIntentUnderLease).toHaveBeenCalledTimes(1);
          expect(gateStoreMock.deadLetterResumeIntentUnderLease.mock.calls[0]).toEqual([
            "gate-1", "lease-settle", "resume delivery attempts exhausted",
          ]);
          expect(warn.mock.calls.some((c) => String(c[0]).includes("dead-lettered") && String(c[0]).includes(branch.why))).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });
    }
  });

  it("cinatra#4312: a failed dead-letter pass is tallied and the claim still runs", async () => {
    gateStoreMock.deadLetterExhaustedResumeIntents.mockRejectedValueOnce(new Error("db blip"));
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    const summary = await sweepArtifactReviewResumeIntents();
    expect(summary.failed).toBe(1);
    expect(gateStoreMock.claimPendingResumeIntents).toHaveBeenCalledTimes(1);
  });

  it("cinatra#4476: the sweep runs the upgrade recovery after the dead-letter pass and before it claims", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    await sweepArtifactReviewResumeIntents();
    expect(recoveryMock.recoverStrandedDeclaredReviews).toHaveBeenCalledTimes(1);
    const at = recoveryMock.recoverStrandedDeclaredReviews.mock.invocationCallOrder[0];
    expect(gateStoreMock.deadLetterExhaustedResumeIntents.mock.invocationCallOrder[0]).toBeLessThan(at);
    expect(at).toBeLessThan(gateStoreMock.claimPendingResumeIntents.mock.invocationCallOrder[0]);
  });

  it("cinatra#4476: a failed recovery pass, and each failed pause, is tallied and the claim still runs", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    recoveryMock.recoverStrandedDeclaredReviews.mockRejectedValueOnce(new Error("db blip"));
    expect((await sweepArtifactReviewResumeIntents()).failed).toBe(1);
    recoveryMock.recoverStrandedDeclaredReviews.mockResolvedValueOnce([
      { runId: "r1", baseTaskId: "wayflow-t1", outcome: "failed", errorName: "DrizzleQueryError", errorCode: "P0001" },
      { runId: "r2", baseTaskId: "wayflow-t2", outcome: "ops", reason: "no-decision" },
      { runId: "r3", baseTaskId: "wayflow-t3", outcome: "rearmed", gateId: "g3" },
    ]);
    expect((await sweepArtifactReviewResumeIntents()).failed).toBe(1);
    expect(gateStoreMock.claimPendingResumeIntents).toHaveBeenCalledTimes(2);
  });

  it("cinatra#4476: a failed pause is logged by its error's name and code, never by a message", async () => {
    gateStoreMock.claimPendingResumeIntents.mockResolvedValue([]);
    recoveryMock.recoverStrandedDeclaredReviews.mockResolvedValueOnce([
      { runId: "r1", baseTaskId: "wayflow-t1", outcome: "failed", errorName: "DrizzleQueryError", errorCode: "P0001" },
      { runId: "r2", baseTaskId: "wayflow-t2", outcome: "failed", errorName: "TypeError" },
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await sweepArtifactReviewResumeIntents()).failed).toBe(2);
      const lines = errors.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines).toContain("[artifact-review-resume] upgrade recovery failed for run=r1 review=wayflow-t1: error=DrizzleQueryError code=P0001");
      expect(lines).toContain("[artifact-review-resume] upgrade recovery failed for run=r2 review=wayflow-t2: error=TypeError");
    } finally {
      errors.mockRestore();
    }
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

  // cinatra#4312 (review 10, finding 1) — the worker closes a decision of an earlier
  // declared review without a send when the run's gates, as it reads them, hold a
  // later review: newer, or with the same created time. The latest-task map here
  // names this task. A later review written after this read is not driven here.
  it.each([["newer", 1], ["equal", 0]])(
    "a declared review's decision on a run whose other declared review is %s is closed without a send",
    async (_label, laterBy) => {
      const at = new Date("2026-11-03T12:00:00Z");
      gateStoreMock.listReviewGatesForRun.mockResolvedValue([
        ...familyRows().map((row) => ({ ...row, createdAt: at })),
        { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-2", status: "pending", createdAt: new Date(at.getTime() + laterBy) },
      ]);
      const outcome = await deliverArtifactReviewResumeIntent(intent());
      expect(outcome).toBe("already-advanced");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
    },
  );

  it("an older declared review of the run does not hold this one's decision: it is sent", async () => {
    const at = new Date("2026-11-03T12:00:00Z");
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-0", status: "resolved", createdAt: new Date(at.getTime() - 1) },
      ...familyRows().map((row) => ({ ...row, createdAt: at })),
    ]);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("delivered");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a decision held by a later declared review whose lease was lost answers lease-lost and sends nothing", async () => {
    const at = new Date("2026-11-03T12:00:00Z");
    gateStoreMock.listReviewGatesForRun.mockResolvedValue([
      ...familyRows().map((row) => ({ ...row, createdAt: at })),
      { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-2", status: "pending", createdAt: new Date(at.getTime() + 1) },
    ]);
    gateStoreMock.markResumeIntentDelivered.mockResolvedValueOnce(false);
    const outcome = await deliverArtifactReviewResumeIntent(intent());
    expect(outcome).toBe("lease-lost");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
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

    it("RED F2 a claimed run with nothing recorded goes back on its gate and is sent only under a fresh pause claim and its fence (row 5)", async () => {
      const { claimPause } = await import("../run-pause-claim");
      // The delivery reads the run again after its release: back on the gate, with the mark cleared.
      storeMock.readAgentRunByTaskId
        .mockResolvedValueOnce(pausedRun({ status: "running", executionAttemptId: "attempt-A" }))
        .mockResolvedValue(pausedRun({ executionAttemptId: "attempt-A" }));
      gateStoreMock.readResumeIntentClaim
        .mockResolvedValueOnce({ runClaimed: true, result: null })
        .mockResolvedValue({ runClaimed: false, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      expect(edges()).toEqual(["running->pending_approval", "pending_approval->running"]);
      for (const call of claimSpy.mock.calls) expect(leaseOf(call)).toEqual({ gateId: "gate-1", leaseToken: "lease-abc" });
      expect(claimSpy.mock.calls[0]![3]).toMatchObject({ resumeGate: { a2aTaskId: "task-1", executionAttemptId: "attempt-A" } });
      expect(claimSpy.mock.calls[1]![3]).toMatchObject({ pauseFence: { token: "tok", generation: 1 } });
      expect(vi.mocked(claimPause)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(claimPause).mock.invocationCallOrder[0]).toBeGreaterThan(claimSpy.mock.invocationCallOrder[0]!);
      expect(claimSpy.mock.invocationCallOrder[1]).toBeLessThan(sendTaskSpy.mock.invocationCallOrder[0]!);
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ pauseClaimToken: "tok" }));
    });

    it("RED F2 the pass after a release never releases or sends again: a run still claimed is left for a later lease", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(edges()).toEqual(["running->pending_approval"]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("RED F2 a release that finds the run moved on, or fails, sends nothing and claims no pause", async () => {
      const { claimPause } = await import("../run-pause-claim");
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      for (const failure of [Object.assign(new Error("stale"), { code: "stale_from_status" }), new Error("db blip")]) {
        claimSpy.mockRejectedValueOnce(failure);
        expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      }
      claimSpy.mockRejectedValueOnce(Object.assign(new Error("lease"), { code: "resume_intent_lease_lost" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(edges()).toEqual(["running->pending_approval", "running->pending_approval", "running->pending_approval"]);
      expect(vi.mocked(claimPause)).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("RED F3 a claimed run with a recorded task replays the handler bound to the claimed gate and sends nothing (row 4)", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running", executionAttemptId: "attempt-A" }));
      const recorded = { id: "task-recorded", status: { state: "input-required" } };
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: recorded });
      resolveLatestSpy.mockResolvedValue("task-recorded");
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({
        fromStatus: "running", task: recorded, claimedGate: { a2aTaskId: "task-1", executionAttemptId: "attempt-A" },
      }));
      expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", "lease-abc");
    });

    it("RED F3 a recorded task of a run that names no gate task is not replayed unbound", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(null);
      resolveRunIdSpy.mockResolvedValue("run-1");
      storeMock.readAgentRunById.mockResolvedValue(pausedRun({ status: "running", a2aTaskId: null }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: { id: "task-recorded" } });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    });

    it("RED F5 a run found through the reverse map with no gate task gets this gate's task under the pause claim, and its fence and answer are bound to it", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(null);
      resolveRunIdSpy.mockResolvedValue("run-1");
      storeMock.readAgentRunById.mockResolvedValue(pausedRun({ a2aTaskId: null, executionAttemptId: "attempt-A" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("delivered");
      expect(storeMock.updateAgentRunA2ATaskId).toHaveBeenCalledWith("run-1", "task-1", { pauseClaimToken: "tok" });
      expect(storeMock.updateAgentRunA2ATaskId.mock.invocationCallOrder[0]).toBeLessThan(claimSpy.mock.invocationCallOrder[0]!);
      const bound = { a2aTaskId: "task-1", executionAttemptId: "attempt-A" };
      expect(claimSpy.mock.calls[0]![3]).toMatchObject({ resumeGate: bound });
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ claimedGate: bound }));
    });

    it("RED F5 a task write the pause claim no longer holds defers the intent: no fence, no send", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(null);
      resolveRunIdSpy.mockResolvedValue("run-1");
      storeMock.readAgentRunById.mockResolvedValue(pausedRun({ a2aTaskId: null }));
      storeMock.updateAgentRunA2ATaskId.mockResolvedValueOnce({ written: false });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("retryable");
      expect(gateStoreMock.deferResumeIntent).toHaveBeenCalledWith("gate-1", "lease-abc");
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
    });

    it("B1 a claimed run with nothing recorded at the intent's last attempt goes back to its gate and is not re-sent (cinatra#4312)", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("retryable");
      expect(edges()).toEqual(["running->pending_approval"]);
      for (const call of claimSpy.mock.calls) expect(leaseOf(call)).toEqual({ gateId: "gate-1", leaseToken: "lease-abc" });
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.recordResumeTaskResult).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      expect(gateStoreMock.deferResumeIntent).not.toHaveBeenCalled();
    });

    it("B2 a release at the last attempt that finds its lease gone reports lease-lost and sends nothing", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      claimSpy.mockImplementation(async () => {
        throw Object.assign(new Error("lease lost"), { code: "resume_intent_lease_lost" });
      });
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("lease-lost");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      claimSpy.mockImplementation(async () => undefined);
    });

    it("B3 the last attempt still replays a recorded task: the replay sends nothing", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running" }));
      const recorded = { id: "task-recorded", status: { state: "input-required" } };
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: recorded });
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("delivered");
      expect(edges()).toEqual([]);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(handleWayflowTaskStateSpy).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "running", task: recorded }));
    });

    it("B5 the release at the last attempt is bound to the gate and execution attempt it read", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running", executionAttemptId: "attempt-A" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("retryable");
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]![3]).toMatchObject({
        resumeIntentLease: { gateId: "gate-1", leaseToken: "lease-abc" },
        resumeGate: { a2aTaskId: "task-1", executionAttemptId: "attempt-A" },
      });
    });

    it("B5 a release at the last attempt that finds the run moved on moves nothing and sends nothing", async () => {
      storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun({ status: "running", executionAttemptId: "attempt-A" }));
      gateStoreMock.readResumeIntentClaim.mockResolvedValue({ runClaimed: true, result: null });
      claimSpy.mockImplementation(async () => {
        throw Object.assign(new Error("stale"), { code: "stale_from_status" });
      });
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("retryable");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
      claimSpy.mockImplementation(async () => undefined);
    });

    it("B4 an unclaimed run at the last attempt is claimed and sent as on any other attempt", async () => {
      expect(await deliverArtifactReviewResumeIntent(intent({ attempts: 20, finalAttempt: true }))).toBe("delivered");
      expect(edges()).toEqual(["pending_approval->running"]);
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
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
      expect(edges()).toEqual([]);
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

    it("RED F4 a scope refusal of a claimed run fails it only from its gate, after the release: never running -> failed", async () => {
      const { assertAgentRunDispatchAuthorized } = await import("../agent-run-serde");
      const denial = Object.assign(new Error("denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: "team gone" });
      vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(denial);
      storeMock.readAgentRunByTaskId
        .mockResolvedValueOnce(pausedRun({ status: "running" }))
        .mockResolvedValue(pausedRun());
      gateStoreMock.readResumeIntentClaim
        .mockResolvedValueOnce({ runClaimed: true, result: null })
        .mockResolvedValue({ runClaimed: false, result: null });
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("refused-out-of-scope");
      expect(edges()).toEqual(["running->pending_approval", "pending_approval->failed"]);
      for (const call of claimSpy.mock.calls) expect(leaseOf(call)).toEqual({ gateId: "gate-1", leaseToken: "lease-abc" });
      vi.mocked(assertAgentRunDispatchAuthorized).mockRejectedValueOnce(denial);
      claimSpy.mockRejectedValueOnce(Object.assign(new Error("lease"), { code: "resume_intent_lease_lost" }));
      expect(await deliverArtifactReviewResumeIntent(intent())).toBe("lease-lost");
      expect(edges()).not.toContain("running->failed");
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


describe("cinatra#4312 — Regenerate on a declared picture leg keeps the pause parked at its successor", () => {
  const SUCCESSOR = "lifecycle-review:repair:0b6f2d6e-3c1a-4c55-9d7e-2f0a1b2c3d4e:1";
  function regeneratedFamily() {
    const rows = familyRows(["resolved", "resolved"]).map((r, i) => ({
      ...r, id: i === 0 ? "gate-post" : "gate-leg2", disposition: i === 0 ? "approve" : "changes_requested",
    }));
    return rows;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunByTaskId.mockImplementation(async (taskId: string) => (taskId === "task-1" ? pausedRun() : null));
    storeMock.readAgentTemplateById.mockResolvedValue(internalTemplate());
    gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(regeneratedFamily());
    sendTaskSpy.mockResolvedValue({ id: "task-x", status: { state: "completed" } });
    resolveLatestSpy.mockResolvedValue("task-1");
    repairStoreMock.readRepairLineageRootGate.mockRejectedValue(lineageStateError("unknown-repair"));
    repairStoreMock.isRepairLineageOpen.mockResolvedValue(false);
  });

  it("the post's decision leaves the run parked while the regenerated picture's lineage is open", async () => {
    repairStoreMock.isRepairLineageOpen.mockResolvedValue(true);
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-post" }));
    expect(outcome).toBe("already-advanced");
    expect(repairStoreMock.isRepairLineageOpen).toHaveBeenCalledWith("gate-leg2");
    expect(repairStoreMock.isRepairLineageOpen).toHaveBeenCalledWith("gate-leg2", TX);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-post", "lease-abc", TX);
  });

  it("a lineage the re-read under the run decision lock finds closed lets the run go on instead of being acknowledged", async () => {
    repairStoreMock.isRepairLineageOpen.mockImplementation(async (_gateId: string, executor?: unknown) => executor === undefined);
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-post" }));
    expect(outcome).toBe("delivered");
    expect(gateStoreMock.withRunDecisionLock).toHaveBeenCalledTimes(1);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-post", "lease-abc");
  });

  it("the post's decision resumes the run once that lineage is decided", async () => {
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-post" }));
    expect(outcome).toBe("delivered");
    expect(repairStoreMock.isRepairLineageOpen).toHaveBeenCalledWith("gate-leg2");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("the successor's decision resumes the paused run through the picture's leg, carrying its own decision", async () => {
    const leg = regeneratedFamily()[1];
    repairStoreMock.readRepairLineageRootGate.mockResolvedValue({
      id: leg.id, runId: leg.runId, orgId: leg.orgId, reviewTaskId: leg.reviewTaskId, pinnedTargets: leg.pinnedTargets,
    });
    const responseText = JSON.stringify(buildReviewApproveEnvelope({ reviewTaskId: SUCCESSOR, comment: null, targets: [] }));
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR, responseText }));
    expect(outcome).toBe("delivered");
    expect(repairStoreMock.readRepairLineageRootGate).toHaveBeenCalledWith(SUCCESSOR, "gate-succ");
    expect(storeMock.readAgentRunByTaskId).toHaveBeenCalledWith("task-1");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    const sent = sendTaskSpy.mock.calls[0]![0] as { message: { contextId: string; parts: Array<{ text: string }> } };
    expect(sent.message.contextId).toBe("ctx-1");
    expect(sent.message.parts[0]!.text).toBe(responseText);
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-succ", "lease-abc");
  });

  it("the successor's decision keeps the run parked while another artifact of the pause is open", async () => {
    const rows = regeneratedFamily();
    rows[0] = { ...rows[0], status: "pending", disposition: null as unknown as string };
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    repairStoreMock.readRepairLineageRootGate.mockResolvedValue({
      id: rows[1].id, runId: rows[1].runId, orgId: rows[1].orgId, reviewTaskId: rows[1].reviewTaskId, pinnedTargets: rows[1].pinnedTargets,
    });
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR }));
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-succ", "lease-abc", TX);
  });

  it("a successor whose lineage started on an ordinary automatic gate keeps the automatic-gate road", async () => {
    repairStoreMock.readRepairLineageRootGate.mockResolvedValue({
      id: "gate-root", runId: "run-1", orgId: "org-1", reviewTaskId: "lifecycle-review:ev-1", pinnedTargets: regeneratedFamily()[1].pinnedTargets,
    });
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR }));
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(storeMock.readAgentRunByTaskId).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-succ", "lease-abc");
  });

  it("a successor whose lineage started on the post's own leg takes the family road with its own decision (b2)", async () => {
    const rows = regeneratedFamily();
    rows[0] = { ...rows[0], disposition: "changes_requested" };
    rows[1] = { ...rows[1], disposition: "approve" };
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    repairStoreMock.readRepairLineageRootGate.mockResolvedValue({
      id: rows[0].id, runId: rows[0].runId, orgId: rows[0].orgId, reviewTaskId: rows[0].reviewTaskId, pinnedTargets: rows[0].pinnedTargets,
    });
    const responseText = JSON.stringify(buildReviewApproveEnvelope({ reviewTaskId: SUCCESSOR, comment: "post successor", targets: [] }));
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR, responseText }));
    expect(outcome).toBe("delivered");
    expect(repairStoreMock.isRepairLineageOpen).toHaveBeenCalledWith("gate-post");
    expect(storeMock.readAgentRunByTaskId).toHaveBeenCalledWith("task-1");
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    const sent = sendTaskSpy.mock.calls[0]![0] as { message: { messageId: string; parts: Array<{ text: string }> } };
    expect(sent.message.parts[0]!.text).toBe(responseText);
    expect(sent.message.messageId).toBe("artifact-review-resume-gate-succ");
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-succ", "lease-abc");
  });

  it("a successor whose lineage started on the post's own leg keeps the run parked while the picture's leg is open (b2)", async () => {
    const rows = regeneratedFamily();
    rows[0] = { ...rows[0], disposition: "changes_requested" };
    rows[1] = { ...rows[1], status: "pending", disposition: null as unknown as string };
    gateStoreMock.listReviewGatesForRun.mockResolvedValue(rows);
    repairStoreMock.readRepairLineageRootGate.mockResolvedValue({
      id: rows[0].id, runId: rows[0].runId, orgId: rows[0].orgId, reviewTaskId: rows[0].reviewTaskId, pinnedTargets: rows[0].pinnedTargets,
    });
    const outcome = await deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR }));
    expect(outcome).toBe("already-advanced");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-succ", "lease-abc", TX);
  });

  it("a failed lineage read on the post's decision throws: nothing is resumed and the intent is not marked done", async () => {
    repairStoreMock.isRepairLineageOpen.mockRejectedValue(new Error("lineage read failed"));
    await expect(deliverArtifactReviewResumeIntent(intent({ gateId: "gate-post" }))).rejects.toThrow("lineage read failed");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("a failed lineage-root read on the successor's decision throws: nothing is resumed and the intent is not marked done", async () => {
    repairStoreMock.readRepairLineageRootGate.mockRejectedValue(new Error("lineage root read failed"));
    await expect(deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR }))).rejects.toThrow("lineage root read failed");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  // Review 1 of cinatra#4339, finding 4: an unknown repair, another attempt, a
  // repair that does not name this gate, a malformed task id and a missing root
  // gate are named errors, never "no lineage" (real store:
  // lifecycle-c-w11-picture-regenerate-parks-run-3035.integration.test.ts).
  it.each(["unknown-repair", "attempt-mismatch", "successor-mismatch", "malformed-successor-task", "missing-root-gate"])(
    "a successor whose lineage reads %s fails closed: nothing is resumed and the intent is not marked done",
    async (code) => {
      repairStoreMock.readRepairLineageRootGate.mockRejectedValue(lineageStateError(code));
      await expect(deliverArtifactReviewResumeIntent(intent({ gateId: "gate-succ", reviewTaskId: SUCCESSOR })))
        .rejects.toMatchObject({ code });
      expect(repairStoreMock.readRepairLineageRootGate).toHaveBeenCalledWith(SUCCESSOR, "gate-succ");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    },
  );
});
