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

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const KEY = "test-context-attest-key-4762";
const CONTEXT = "ctx-gate-4762";
const TASK = "task-gate-4762";
const GATE = "cinatra_publish_gate__publish";
const AUTHORITY = { orgId: "org-test", can: () => true };
const SURFACED = { what: "the post" };
const STARTED = new Date("2026-11-20T10:00:00Z");
const REASON = "No approved review came before this change outside Cinatra.";

type Review = { status: string; disposition: string | null; createdAt: Date; resolvedBy?: string | null; runGeneration?: number | null };
const listReviews = vi.fn(async (_runId: string) => [] as Review[]);

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
const approved = (minutes: number, resolvedBy = "user-reviewer", runGeneration: number | null = 0): Review =>
  ({ status: "resolved", disposition: "approve", createdAt: at(minutes), resolvedBy, runGeneration });
const changesRequested = (minutes: number, runGeneration: number | null = 0): Review =>
  ({ status: "resolved", disposition: "changes_requested", createdAt: at(minutes), runGeneration });

const transitions = () =>
  (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { error?: string; completedAt?: Date } | undefined]>)
    .map(([, from, to, patch]) => ({ from, to, error: patch?.error }));

const previousKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
const seamSlot = globalThis as { __cinatraArtifactReviewGateSeam?: unknown };
const previousSeam = seamSlot.__cinatraArtifactReviewGateSeam;
beforeAll(() => {
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
  seamSlot.__cinatraArtifactReviewGateSeam = { listReviews };
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
    listReviews.mockResolvedValue([{ status: "resolved", disposition: "changes_requested", createdAt: at(4) }, approved(5)]);
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
    // Attempt A (generation 0) answers late: with no review of B, or with A's own approved review, it writes nothing.
    for (const reviews of [[], [approved(-30, "user-reviewer", 0)]]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate(makeRun({ resetGeneration: 1 }), makeRun({ startedAt: null, resetGeneration: 0 }));
      expect(landed).toEqual([]);
      expect(onInterruptSpy).not.toHaveBeenCalled();
    }
    // Every move this gate makes names the attempt that reached it.
    const named = (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { attemptGeneration?: number }]>)
      .map(([, , , patch]) => patch?.attemptGeneration);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((g) => g === 0)).toBe(true);
    // B's own callback, at generation 1 with B's approved review, still lands.
    vi.clearAllMocks();
    listReviews.mockResolvedValue([approved(5, "user-reviewer", 1)]);
    await reachPublishGate(makeRun({ resetGeneration: 1 }));
    expect(landed).toEqual([{ to: "pending_approval", error: undefined }]);
  });

  // red-first-expect: expected [ { from: 'running', …(2) } ] to deeply equal [ { from: 'running', …(2) } ]
  it("reviews raised in one transaction (one created_at) resolve the same in any row order", async () => {
    // A family member settled changes requested beside an approved sibling: no approval came after it, in either order.
    for (const reviews of [[changesRequested(5), approved(5)], [approved(5), changesRequested(5)]]) {
      vi.clearAllMocks();
      listReviews.mockResolvedValue(reviews);
      await reachPublishGate();
      expectStoppedWithoutWriting();
    }
    // Its successor, raised after it and approved, opens the card in any order.
    for (const reviews of [[changesRequested(5), approved(5), approved(9)], [approved(9), approved(5), changesRequested(5)]]) {
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

  it("an unreadable review ends the run failed and opens no decision row", async () => {
    listReviews.mockRejectedValue(new Error("db down"));
    await reachPublishGate();
    expect(transitions().map((m) => `${m.from}->${m.to}:${(m.error ?? "").split(":")[0]}`)).toEqual(["running->failed:publish_review_unread"]);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
  });

  it("a different reviewer and decider still pass: a review another member approved opens the card for anyone allowed to decide", async () => {
    listReviews.mockResolvedValue([approved(5, "user-reviewer")]);
    await reachPublishGate();
    expect(listReviews).toHaveBeenCalledWith("run-4762");
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    // Who reviewed is never compared with who decides: the run's owner, the reviewer and the decider are three people.
  });
});
