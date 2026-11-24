import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// cinatra#4762 (design app-lifecycle-cards §XV): a publish card opens only after an approved review card (§II) earlier
// in the same run, in its current attempt. A run that reaches an external write with no approved review before it ends
// stopped with the reason recorded, opens no decision row and sends nothing. The reviewer and the person who answers the
// publish card may differ. These tests drive the real handleWayflowTaskState and the real claim verifier; the review
// store is the boot-bound gate seam's listReviews.
const { onInterruptSpy } = vi.hoisted(() => ({ onInterruptSpy: vi.fn() }));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    readLatestAgUiInterrupt: async () => {
      const last = onInterruptSpy.mock.calls.at(-1) as
        | [Record<string, unknown>, string, Record<string, unknown>, string, string?]
        | undefined;
      if (!last) return null;
      const [schema, xRenderer, values, reviewTaskId, fieldName] = last;
      return { schema, xRenderer, values, reviewTaskId, fieldName };
    },
    DualAdapterDispatch: class MockDualAdapterDispatch {
      onInterrupt = onInterruptSpy;
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => []),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

const gateStore = vi.hoisted(() => ({
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberWayflowGateNodeClaim: vi.fn(async () => undefined),
  rememberWayflowGateTask: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...gateStore };
});

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  // The rows of the plan the run's current attempt was dispatched with (agent_runs.dispatch_publish_rows), for a node.
  readDispatchedPublishRows: vi.fn(async (_runId: string, _nodeId: string) => null as unknown),
  decide: vi.fn(),
  readLatestDecisionForRun: vi.fn(async () => null),
  readOpenDecisionForRun: vi.fn(async () => null),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

// The decider's rights check (enforcePublishDecisionAccess) asks the run policy and the organization role; both are
// answered here so a real Publish decision runs against the run this file parks.
const enforceRunAccess = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../auth-policy", async (orig) => ({ ...((await orig()) as object), enforceRunAccess, resolveEffectivePolicy: () => "owner-only" }));
const resolveOrgRoleForUser = vi.hoisted(() => vi.fn(async () => "member" as string | undefined));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser }));

import { handleWayflowTaskState } from "../execution";
import { declinePublishDecision } from "../publish-decision-actions";
import type { AgentRunRecord } from "../store";

const KEY = "test-context-attest-key-4762";
const CONTEXT = "ctx-gate-4762";
const TASK = "task-gate-4762";
const GATE = "cinatra_publish_gate__publish";
const AUTHORITY = { orgId: "org-test", can: () => true };
const SURFACED = { what: "the post" };
const STARTED = new Date("2026-11-20T10:00:00Z");
const REASON = "No approved review came before this change outside Cinatra.";

type Review = {
  id?: string; status: string; disposition: string | null; createdAt: Date; resolvedBy?: string | null; runGeneration?: number | null;
  fingerprint?: string | null; successorGateId?: string | null;
};
/** The fingerprint a person's decision stamps on its review (the decision core's sha256). */
const HUMAN_DECISION = "d".repeat(64);
const listReviews = vi.fn(async (_runId: string) => [] as Review[]);
/** Does an output of the attempt still wait for the review orchestration (a pending produced event of it)? */
const hasPendingProducedReview = vi.fn(async (_input: { orgId: string; runId: string; generation: number }) => false);

function sign(node: string) {
  return { node, attestation: `g1:${createHmac("sha256", KEY).update(`g1\n${CONTEXT}\n${TASK}\n${node}`).digest("hex")}` };
}

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-4762", templateId: "tmpl-1", versionId: null, runBy: "user-a", status: "running", inputParams: {},
    stepResults: null, startedAt: STARTED, completedAt: null, error: null, title: null, createdAt: new Date("2026-11-20"),
    sourceType: "agent_builder", sourceId: null, packageVersion: null, a2aTaskId: null, a2aContextId: CONTEXT,
    parentRunId: null, agUiEnabled: null, lgThreadId: null, traceId: null, timeoutSeconds: null, streamedText: null,
    producedReviewPark: null, authPolicy: null, orgId: "org-test", projectId: null, idempotencyKey: null,
    oboCeiling: null, dependentInstallId: null, humanPresent: null, lifecycleMoment: null, lifecycleCardKind: null,
    lifecycleCardRef: null, executionAttemptId: null, resetGeneration: 0, ...overrides,
  } as AgentRunRecord;
}

const template = {
  id: "tmpl-1", orgId: null, creatorId: null, name: "Publishing Agent", description: "", sourceNl: "", compiledPlan: [],
  inputSchema: { properties: {}, required: [] }, outputSchema: null, taskSpec: null, status: "published",
  packageName: "@acme/publishing-agent", packageVersion: null, sourceType: "internal", gatedSteps: [],
  publishingSteps: ["publish"], publishRows: { publish: [{ label: "Title", input: "title" }] }, triggerMode: "none",
  approvalPolicy: { steps: [] }, agentDependencies: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
};

function pausedTask() {
  return {
    id: TASK,
    contextId: CONTEXT,
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [{ role: "agent", parts: [{ kind: "text", text: JSON.stringify(SURFACED) }], metadata: { cinatra_gate_node: sign(GATE) } }],
  };
}

/** The run reaches its publish gate. `stored` is the run row as the store answers it now; `held` is the record the
 *  attempt's executor read for its attempt (read before the dispatch stamped the start, so it carries none). */
async function reachPublishGate(stored: AgentRunRecord = makeRun(), held: AgentRunRecord = makeRun({ startedAt: null, resetGeneration: stored.resetGeneration })) {
  storeMock.readAgentRunById.mockResolvedValue(stored);
  await handleWayflowTaskState({ authority: AUTHORITY, runId: held.id, run: held, fromStatus: "running", task: pausedTask() });
}

const at = (minutes: number) => new Date(STARTED.getTime() + minutes * 60_000);
let gateSeq = 0;
const gateId = () => `gate-${++gateSeq}`;
const approved = (minutes: number, resolvedBy = "user-reviewer", runGeneration: number | null = 0): Review =>
  ({ id: gateId(), status: "resolved", disposition: "approve", createdAt: at(minutes), resolvedBy, runGeneration, fingerprint: HUMAN_DECISION, successorGateId: null });
/** A review settled changes requested; `successor` is the gate its repair recorded as the successor (none: no repair
 *  of it has finished). */
const changesRequested = (minutes: number, runGeneration: number | null = 0, successor?: Review): Review =>
  ({ id: gateId(), status: "resolved", disposition: "changes_requested", createdAt: at(minutes), runGeneration, fingerprint: HUMAN_DECISION, successorGateId: successor?.id ?? null });

const transitions = () =>
  (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { error?: string; completedAt?: Date } | undefined]>)
    .map(([, from, to, patch]) => ({ from, to, error: patch?.error }));

const previousKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
const seamSlot = globalThis as { __cinatraArtifactReviewGateSeam?: unknown };
const previousSeam = seamSlot.__cinatraArtifactReviewGateSeam;
beforeAll(() => {
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
  seamSlot.__cinatraArtifactReviewGateSeam = { listReviews, hasPendingProducedReview };
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = previousKey;
  seamSlot.__cinatraArtifactReviewGateSeam = previousSeam;
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  listReviews.mockReset();
  listReviews.mockResolvedValue([]);
  hasPendingProducedReview.mockReset();
  hasPendingProducedReview.mockResolvedValue(false);
  storeMock.readAgentTemplateById.mockResolvedValue(template);
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  decisions.insertParkedDecision.mockResolvedValue({ inserted: true, current: true, decision: { id: "dec-1", runId: "run-4762", nodeId: "publish", status: "parked" } });
  decisions.readDispatchedPublishRows.mockResolvedValue([{ label: "Title", input: "title" }]);
});

/** The run ended stopped with the reason, no decision row opened and nothing was offered or sent. */
function expectStoppedWithoutWriting() {
  expect(transitions()).toEqual([{ from: "running", to: "stopped", error: REASON }]);
  const patch = (storeMock.transitionRunStatus.mock.calls[0] as unknown as [string, string, string, { completedAt?: Date }])[3];
  expect(patch.completedAt).toBeInstanceOf(Date);
  expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(onInterruptSpy).not.toHaveBeenCalled();
}

describe("a publish card opens only after an approved review earlier in the same run (cinatra#4762)", () => {
  it("an approved earlier review reaches the publish card: the run's reviews are read, the decision parks", async () => {
    listReviews.mockResolvedValue([approved(5)]);
    await reachPublishGate();
    expect(listReviews).toHaveBeenCalledWith("run-4762");
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    expect(listReviews.mock.invocationCallOrder[0]!).toBeLessThan(decisions.insertParkedDecision.mock.invocationCallOrder[0]!);
  });

  it("a run with no review ends stopped with the reason: no decision row, no write", async () => {
    await reachPublishGate();
    expect(listReviews).toHaveBeenCalledWith("run-4762");
    expectStoppedWithoutWriting();
  });

  it("a declined review ends the run the same way, even beside an approved one", async () => {
    listReviews.mockResolvedValue([{ status: "resolved", disposition: "reject", createdAt: at(5) }]);
    await reachPublishGate();
    expectStoppedWithoutWriting();
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(4), { status: "resolved", disposition: "reject", createdAt: at(5) }]);
    await reachPublishGate();
    expectStoppedWithoutWriting();
  });

  it("a review still open, or a review superseded or changed with no approved review after it, is no approved review", async () => {
    for (const reviews of [
      [{ status: "pending", disposition: null, createdAt: at(5) }],
      [approved(4), { status: "pending", disposition: null, createdAt: at(5) }],
      [{ status: "resolved", disposition: "changes_requested", createdAt: at(5) }],
      [approved(4), { status: "resolved", disposition: "changes_requested", createdAt: at(5) }],
    ]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate();
      expectStoppedWithoutWriting();
    }
    // A Regenerate settles the first review; its successor, approved, opens the publish card.
    vi.clearAllMocks();
    const successor = approved(5);
    listReviews.mockResolvedValue([changesRequested(4, 0, successor), successor]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  it("a review approved in an EARLIER attempt, before a retry's reset, does not count", async () => {
    // The retry's reset raised the generation to 1; the approval was raised in generation 0.
    listReviews.mockResolvedValue([approved(-30, "user-reviewer", 0)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expectStoppedWithoutWriting();
    // The same approval made again in this attempt opens the card.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(-30, "user-reviewer", 0), approved(5, "user-reviewer", 1)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    // A review raised while the run was not executing (generation -1) belongs to no attempt.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5, "user-reviewer", -1)]);
    await reachPublishGate();
    expectStoppedWithoutWriting();
    // A review raised before the column existed reads as generation 0: it counts for a run never reset only.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5, "user-reviewer", null)]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    vi.clearAllMocks();
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expectStoppedWithoutWriting();
  });

  it("a retry whose start stamp a later cleanup cleared still counts its own approved review", async () => {
    // The reset raised the generation to 1; the retry's dispatch stamped its start and a cleanup cleared it again, so
    // the run row carries no start stamp. The review this attempt approved still opens the card.
    listReviews.mockResolvedValue([approved(-30, "user-reviewer", 0), approved(5, "user-reviewer", 1)]);
    await reachPublishGate(makeRun({ resetGeneration: 1, startedAt: null }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
  });

  // red-first-expect: expected [ { to: 'pending_approval', …(1) } ] to deeply equal []
  it("a callback of an attempt a retry ended moves nothing on the newer attempt's row", async () => {
    // The run row is at generation 1 (retry B runs); the store's compare-and-set lands only at that generation, as
    // transitionRunStatus does, and a move that names no attempt lands on whatever attempt the row holds.
    const landed: Array<{ to: string; error?: string }> = [];
    storeMock.transitionRunStatus.mockImplementation((async (...args: unknown[]) => {
      const [, , to, patch] = args as [string, string, string, { attemptGeneration?: number; error?: string } | undefined];
      if (patch?.attemptGeneration !== undefined && patch.attemptGeneration !== 1) {
        throw new storeMock.RunTransitionError("stale_from_status", "the run moved on");
      }
      landed.push({ to, error: patch?.error });
    }) as never);
    // The store's insert, as insertParkedDecision runs it: with an attempt named, the row is written only while the run
    // is at that generation, in the insert's own transaction; a row with none named is stamped with the run's live one.
    const parkedRows: Array<{ runGeneration: number }> = [];
    decisions.insertParkedDecision.mockImplementation((async (input: { attemptGeneration?: number }) => {
      if (input.attemptGeneration !== undefined && input.attemptGeneration !== 1) {
        throw Object.assign(new Error("the attempt that reached this stop has ended"), { code: "stale-attempt" });
      }
      parkedRows.push({ runGeneration: 1 });
      return { inserted: true, current: true, decision: { id: `dec-${parkedRows.length}`, runId: "run-4762", nodeId: "publish", status: "parked" } };
    }) as never);
    // Attempt A (generation 0) answers late: with no review of B, or with A's own approved review, it writes nothing:
    // no move of the run and no decision row.
    const named: Array<number | undefined> = [];
    for (const reviews of [[], [approved(-30, "user-reviewer", 0)]]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate(makeRun({ resetGeneration: 1 }), makeRun({ startedAt: null, resetGeneration: 0 }));
      expect(landed).toEqual([]);
      expect(parkedRows).toEqual([]);
      expect(onInterruptSpy).not.toHaveBeenCalled();
      named.push(...(storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { attemptGeneration?: number }]>)
        .map(([, , , patch]) => patch?.attemptGeneration));
    }
    // The insert A reached named A's attempt.
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith(expect.objectContaining({ attemptGeneration: 0 }));
    // Every move this gate makes names the attempt that reached it.
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((g) => g === 0)).toBe(true);
    // B's own callback, at generation 1 with B's approved review, still lands.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5, "user-reviewer", 1)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expect(landed).toEqual([{ to: "pending_approval", error: undefined }]);
    expect(parkedRows).toEqual([{ runGeneration: 1 }]);
  });

  // red-first-expect: expected [ 'pending_approval' ] to deeply equal [ 'stopped' ]
  it("an optional review its expiry settled 'approve' is no person's approval: the run ends stopped", async () => {
    // The expiry resolves an optional review 'approve' with a synthetic fingerprint and no person.
    const expired: Review = { ...approved(5), resolvedBy: null, fingerprint: "expiry:gate-optional" };
    listReviews.mockResolvedValue([expired]);
    await reachPublishGate();
    expect(transitions().map((m) => m.to)).toEqual(["stopped"]);
    expectStoppedWithoutWriting();
    // A review with no fingerprint at all is no person's approval either.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([{ ...approved(5), fingerprint: null }]);
    await reachPublishGate();
    expectStoppedWithoutWriting();
    // Beside it, a review a person approved opens the card; the expired one neither blocks nor counts.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([expired, approved(6)]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  // red-first-expect: expected [ { from: 'running', …(2) } ] to deeply equal [ { from: 'running', …(2) } ]
  it("a change request is cleared only by its own repair successor, never by another review approved later", async () => {
    // Artifact A's review was settled changes requested and nothing repaired it; artifact B's review, raised later in the
    // same attempt, was approved. B is no successor of A: A's request stands, unchanged A is never published.
    const unrepaired = changesRequested(5);
    const laterB = approved(9);
    for (const reviews of [[unrepaired, laterB], [laterB, unrepaired]]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate();
      expectStoppedWithoutWriting();
    }
    // A's repair recorded A2 as its successor; A2 approved clears A's request, in any row order, beside B.
    const a2 = approved(7);
    for (const reviews of [[changesRequested(5, 0, a2), a2, laterB], [laterB, a2, changesRequested(5, 0, a2)]]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate();
      expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    }
    // Two approved members of one family open it too.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5), approved(5)]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  // red-first-expect: expected [ { from: 'running', …(2) } ] to deeply equal [ { from: 'running', …(2) } ]
  it("the lineage clears a change request only through successors of this attempt that end in a person's approval", async () => {
    const laterB = approved(9);
    const cases: Array<{ label: string; reviews: Review[] }> = [];
    // The successor is still open.
    const open: Review = { id: gateId(), status: "pending", disposition: null, createdAt: at(6), runGeneration: 0, successorGateId: null };
    cases.push({ label: "open successor", reviews: [changesRequested(5, 0, open), open, laterB] });
    // The successor was settled by the optional review's expiry, with no person.
    const expired: Review = { ...approved(6), fingerprint: "expiry:gate-optional" };
    cases.push({ label: "expired successor", reviews: [changesRequested(5, 0, expired), expired, laterB] });
    // The successor was declined.
    const declined: Review = { ...approved(6), disposition: "reject" };
    cases.push({ label: "declined successor", reviews: [changesRequested(5, 0, declined), declined, laterB] });
    // The successor belongs to another attempt (it is not among this attempt's reviews).
    const elsewhere = approved(6, "user-reviewer", 1);
    cases.push({ label: "successor of another attempt", reviews: [changesRequested(5, 0, elsewhere), elsewhere, laterB] });
    // The repair names a gate this run does not own.
    cases.push({ label: "unknown successor", reviews: [{ ...changesRequested(5), successorGateId: "gate-elsewhere" }, laterB] });
    // The successor was itself settled changes requested and nothing repaired it.
    const again = changesRequested(6);
    cases.push({ label: "successor changed again", reviews: [changesRequested(5, 0, again), again, laterB] });
    // A lineage that names itself again clears nothing.
    const loopA: Review = { ...changesRequested(5), id: "loop-a", successorGateId: "loop-b" };
    const loopB: Review = { ...changesRequested(6), id: "loop-b", successorGateId: "loop-a" };
    cases.push({ label: "a lineage loop", reviews: [loopA, loopB, laterB] });
    const outcomes: Array<{ label: string; to: string[] }> = [];
    for (const { label, reviews } of cases) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate();
      outcomes.push({ label, to: transitions().map((m) => m.to) });
    }
    expect(outcomes).toEqual(cases.map(({ label }) => ({ label, to: ["stopped"] })));
    // A successor changed again whose own successor a person approved clears the whole lineage.
    const last = approved(8);
    const middle = changesRequested(6, 0, last);
    vi.clearAllMocks();
    listReviews.mockResolvedValue([changesRequested(5, 0, middle), middle, last]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  // red-first-expect: expected [ { from: 'running', …(2) } ] to deeply equal [ { from: 'running', …(2) } ]
  it("an output of the attempt still waiting for the review orchestration holds the card back, as an open review does", async () => {
    // One review is approved; another output of the same attempt is still a pending produced event the drain has not
    // reached. The review it may raise is not settled, so no card opens and nothing is written.
    listReviews.mockResolvedValue([approved(5)]);
    hasPendingProducedReview.mockResolvedValue(true);
    await reachPublishGate();
    expectStoppedWithoutWriting();
    expect(hasPendingProducedReview).toHaveBeenCalledWith({ orgId: "org-test", runId: "run-4762", generation: 0 });
    // The read names the attempt that reached the gate.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5, "user-reviewer", 1)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expect(hasPendingProducedReview).toHaveBeenCalledWith({ orgId: "org-test", runId: "run-4762", generation: 1 });
    // Once the drain settled it (no event of the attempt pending), the approved review opens the card.
    vi.clearAllMocks();
    hasPendingProducedReview.mockResolvedValue(false);
    listReviews.mockResolvedValue([approved(5)]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    // A fault of that read ends the run failed, as an unreadable review does.
    vi.clearAllMocks();
    hasPendingProducedReview.mockRejectedValue(new Error("db down"));
    await reachPublishGate();
    expect(transitions().map((m) => `${m.from}->${m.to}:${(m.error ?? "").split(":")[0]}`)).toEqual(["running->failed:publish_review_unread"]);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
  });

  it("an unreadable review ends the run failed and opens no decision row", async () => {
    listReviews.mockRejectedValue(new Error("db down"));
    await reachPublishGate();
    expect(transitions().map((m) => `${m.from}->${m.to}:${(m.error ?? "").split(":")[0]}`)).toEqual(["running->failed:publish_review_unread"]);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
  });

  it("a review one member approved opens the card, and a third member, neither owner nor reviewer, decides it", async () => {
    listReviews.mockResolvedValue([approved(5, "user-reviewer")]);
    await reachPublishGate();
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    const parked = { id: "dec-1", runId: "run-4762", nodeId: "publish", status: "parked" };
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    // The run waits at the gate; its owner is user-a, the review was approved by user-reviewer, user-decider answers.
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ status: "pending_approval" }));
    decisions.readOpenDecisionForRun.mockResolvedValue(parked as never);
    decisions.decide.mockResolvedValue({ outcome: "won", decision: { ...parked, status: "declined" } });
    storeMock.transitionRunStatus.mockClear();
    const decider = { actorType: "human", source: "ui", userId: "user-decider" } as never;
    expect(await declinePublishDecision({ runId: "run-4762", actorContext: decider })).toEqual({ ok: true, runStopped: true });
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "declined", actor: "user-decider", note: null });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-test", "user-decider");
    const [runId, from, to] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [string, string, string];
    expect([runId, from, to]).toEqual(["run-4762", "pending_approval", "stopped"]);
  });

  // red-first-expect: expected [] to deeply equal [ { from: 'pending_approval', …(2) } ]
  it("a gate redelivered after its decision parked, with no approved review, ends stopped and closes that row in the stop", async () => {
    // The row parked before the review rule; the run waits at the gate when the same gate task is delivered again. The
    // store closes the attempt's parked rows only inside a move that asks for it, as transitionRunStatus does.
    const rows = [{ id: "dec-old", status: "parked" }];
    storeMock.transitionRunStatus.mockImplementation((async (...args: unknown[]) => {
      const patch = args[3] as { endParkedDecisions?: boolean; attemptGeneration?: number } | undefined;
      if (patch?.endParkedDecisions === true && patch.attemptGeneration === 0) for (const row of rows) if (row.status === "parked") row.status = "run_ended";
    }) as never);
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ status: "pending_approval" }));
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-4762", run: makeRun({ status: "pending_approval", startedAt: null }), fromStatus: "pending_approval", task: pausedTask(),
    });
    expect(transitions()).toEqual([{ from: "pending_approval", to: "stopped", error: REASON }]);
    expect(rows).toEqual([{ id: "dec-old", status: "run_ended" }]);
    // An unreadable review ends the attempt failed, and closes its parked rows the same way.
    rows[0]!.status = "parked";
    vi.clearAllMocks();
    listReviews.mockRejectedValue(new Error("db down"));
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-4762", run: makeRun({ status: "pending_approval", startedAt: null }), fromStatus: "pending_approval", task: pausedTask(),
    });
    expect(transitions().map((m) => `${m.from}->${m.to}`)).toEqual(["pending_approval->failed"]);
    expect(rows).toEqual([{ id: "dec-old", status: "run_ended" }]);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
  });

  // red-first-expect: expected [ undefined ] to deeply equal [ +0 ]
  it("a delayed writer of attempt A, run after B's reset, records A's generation: a person's approval of its review opens no card for B", async () => {
    const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server/request-context");
    const emitModule = await import("@/lib/lifecycle/lifecycle-emit");
    const { buildProducedEventInsertOp } = emitModule;
    const attemptOf = (emitModule as { producerAttemptForRun?: (runId: string) => unknown }).producerAttemptForRun ?? (() => null);
    /** A writer of the attempt whose frame the run worker opened: the generation its produced event records. */
    const produce = (resetGeneration: number) => mcpRequestContextStorage.run(
      { runAttempt: { runId: "run-4762", resetGeneration } } as never,
      () => {
        const op = buildProducedEventInsertOp("cinatra", {
          orgId: "org-test", artifactId: "art-post", representationRevisionId: `rev-${resetGeneration}`,
          emitter: "createSemanticArtifact", originKind: "agent_generated", producerRunId: "run-4762",
          producerAttempt: attemptOf("run-4762") as never,
        });
        return { text: op.text, generation: op.values[11] as number | undefined };
      },
    );
    // Attempt A (generation 0) started; its writer runs late, after a retry's reset began B (generation 1). It records
    // A's generation, which the drain stamps on the review it raises for the event.
    const writtenA = produce(0);
    const stampedA = writtenA.generation;
    expect([stampedA]).toEqual([0]);
    // The insert records the carried generation ($12) first; the run row is never read for it.
    expect(writtenA.text.replace(/\s+/g, " ")).toContain("coalesce($12::integer,");
    // A person approves that review. B reaches its publish gate: A's approval is no review of B, so the run ends stopped.
    listReviews.mockResolvedValue([approved(5, "user-reviewer", stampedA as number)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expectStoppedWithoutWriting();
    // B's own writer records B's generation, and a person's approval of its review opens B's card.
    vi.clearAllMocks();
    const stampedB = produce(1).generation;
    expect(stampedB).toBe(1);
    listReviews.mockResolvedValue([approved(5, "user-reviewer", stampedA as number), approved(6, "user-reviewer", stampedB as number)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });
});
