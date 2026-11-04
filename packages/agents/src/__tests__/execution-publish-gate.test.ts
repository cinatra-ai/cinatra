import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// cinatra#4150 (A4 without the moment, A10): the input-required branch classifies a
// publish gate FIRST. A verified `cinatra_publish_gate__<node>` claim parks the run on
// its decision record (written first and awaited) and offers no renderer and no generic
// review task. A record fault, or a missing or unverified claim on a template that lists
// publishing steps, ends the run failed. A template that lists none keeps today's road.
// These tests drive the real handleWayflowTaskState and the real claim verifier.

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
  decide: vi.fn(),
  readLatestDecisionForRun: vi.fn(async () => null),
  readOpenDecisionForRun: vi.fn(async () => null),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const KEY = "test-context-attest-key-4150";
const CONTEXT = "ctx-gate-1";
const TASK = "task-gate-1";
const GATE = "cinatra_publish_gate__publish";
const AUTHORITY = { orgId: "org-test", can: () => true };
const SURFACED = { what: "the post", where: "the blog" };

function sign(node: string, key = KEY) {
  return { node, attestation: `g1:${createHmac("sha256", key).update(`g1\n${CONTEXT}\n${TASK}\n${node}`).digest("hex")}` };
}

function makeRun(): AgentRunRecord {
  return {
    id: "run-pub-1",
    templateId: "tmpl-1",
    versionId: null,
    runBy: "user-a",
    status: "running",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    producedReviewPark: null,
    authPolicy: null,
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: null,
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
    executionAttemptId: null,
  };
}

function makeTemplate(publishingSteps: string[] | null) {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Publishing Agent",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: {}, required: [] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: null,
    packageVersion: null,
    gatedSteps: [],
    publishingSteps,
    triggerMode: "none",
    approvalPolicy: { steps: [] },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function pausedTask(claim?: unknown) {
  return {
    id: TASK,
    contextId: CONTEXT,
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [
      {
        role: "agent",
        parts: [{ kind: "text", text: JSON.stringify(SURFACED) }],
        ...(claim === undefined ? {} : { metadata: { cinatra_gate_node: claim } }),
      },
    ],
  };
}

function parkedRow(status = "parked") {
  return { id: "dec-1", runId: "run-pub-1", nodeId: "publish", status };
}

async function pause(claim?: unknown, fromStatus: "running" | "pending_approval" = "running") {
  const run = makeRun();
  await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus, task: pausedTask(claim) });
}

const transitions = () =>
  (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { error?: string } | undefined]>).map(
    ([, from, to, patch]) => ({ from, to, error: patch?.error }),
  );

const previousKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
beforeAll(() => {
  process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = previousKey;
  vi.doUnmock("@cinatra-ai/agent-ui-protocol/server");
  vi.doUnmock("../store");
  vi.doUnmock("../trigger-gate");
  vi.doUnmock("../skill-autosave");
  vi.doUnmock("../wayflow-url");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.doUnmock("../publish-decision-store");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(["publish"]));
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  decisions.insertParkedDecision.mockResolvedValue({ inserted: true, decision: parkedRow() });
  decisions.decide.mockResolvedValue({ outcome: "won", decision: parkedRow("run_ended") });
});

describe("a run that reaches a publish gate (A4 without the moment)", () => {
  it("writes ONE parked decision first, then waits in pending_approval, with no review offered", async () => {
    await pause(sign(GATE));
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith({
      orgId: "org-test",
      runId: "run-pub-1",
      nodeId: "publish",
      gateTaskId: TASK,
      a2aContextId: CONTEXT,
      surfacedValues: SURFACED,
    });
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
    expect(decisions.insertParkedDecision.mock.invocationCallOrder[0]!).toBeLessThan(
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
    );
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(gateStore.rememberWayflowGateTask).not.toHaveBeenCalled();
  });

  it("the prefix wins: a step the template does not list, or a template with no list, is still held", async () => {
    for (const steps of [[], null, ["another_step"]]) {
      vi.clearAllMocks();
      storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(steps));
      decisions.insertParkedDecision.mockResolvedValue({ inserted: true, decision: parkedRow() });
      await pause(sign(GATE));
      expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
      expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
      expect(onInterruptSpy).not.toHaveBeenCalled();
    }
  });

  it("a lost move to pending_approval closes the decision run_ended", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    await pause(sign(GATE));
    expect(decisions.decide).toHaveBeenCalledWith("dec-1", { from: "parked", to: "run_ended", actor: null });
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a gate that reaches an already waiting run records the decision and moves nothing", async () => {
    await pause(sign(GATE), "pending_approval");
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a store fault on the move to pending_approval is not swallowed: the row stays parked, nothing is offered", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down"));
    const run = makeRun();
    await expect(
      handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(sign(GATE)) }),
    ).rejects.toThrow("db down");
    expect(decisions.insertParkedDecision).toHaveBeenCalledTimes(1);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a task without a context id is verified against the run's context id", async () => {
    const run = { ...makeRun(), a2aContextId: CONTEXT };
    const task = { ...pausedTask(sign(GATE)), contextId: null };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith(expect.objectContaining({ a2aContextId: CONTEXT, nodeId: "publish" }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  it("with no context id on the task or the run, the claim cannot verify and a publishing template fails the run", async () => {
    const run = makeRun();
    const task = { ...pausedTask(sign(GATE)), contextId: null };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.error ?? "")).toEqual([expect.stringMatching(/^publish_gate_unverified/)]);
  });

  it.each([
    ["a text that is no JSON", "publish it?"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"the post"'],
    ["no text part", null],
  ])("%s surfaces no values: the row is written with an empty object", async (_label, text) => {
    const run = makeRun();
    const signed = pausedTask(sign(GATE));
    const parts = text === null ? [] : [{ kind: "text", text }];
    const task = { ...signed, history: [{ ...signed.history[0]!, parts }] };
    await handleWayflowTaskState({ authority: AUTHORITY, runId: run.id, run, fromStatus: "running", task });
    expect(decisions.insertParkedDecision).toHaveBeenCalledWith(expect.objectContaining({ surfacedValues: {} }));
    expect(transitions()).toEqual([{ from: "running", to: "pending_approval", error: undefined }]);
  });

  it("a gate task already answered is not parked again", async () => {
    decisions.insertParkedDecision.mockResolvedValue({ inserted: false, decision: parkedRow("declined") });
    await pause(sign(GATE));
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });
});

describe("a publish gate that cannot be held ends the run failed (A10)", () => {
  it("a decision record that cannot be written fails the run and offers nothing", async () => {
    decisions.insertParkedDecision.mockRejectedValue(new Error("db down"));
    await pause(sign(GATE));
    const moves = transitions();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.from).toBe("running");
    expect(moves[0]!.to).toBe("failed");
    expect(moves[0]!.error).not.toContain("db down");
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["no claim", undefined],
    ["a claim signed with another key", sign(GATE, "another-key")],
    ["a claim signed for another step", { ...sign("some_other_step"), node: GATE }],
    ["a claim of another shape", { node: GATE }],
  ])("%s on a template that lists publishing steps fails the run publish_gate_unverified", async (_label, claim) => {
    await pause(claim);
    const moves = transitions();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.to).toBe("failed");
    expect(moves[0]!.error).toMatch(/^publish_gate_unverified/);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a template that is not found fails closed: a claimless pause ends the run failed", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    await pause(undefined);
    const moves = transitions();
    expect(moves.map((m) => m.to)).toEqual(["failed"]);
    expect(moves[0]!.error).toMatch(/^publish_gate_unverified/);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a stale answer to the fail move is swallowed (the run already left); any other fault is not", async () => {
    decisions.insertParkedDecision.mockRejectedValue(new Error("db down"));
    storeMock.transitionRunStatus.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale_from_status" }));
    await expect(pause(sign(GATE))).resolves.toBeUndefined();
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("run store down"));
    await expect(pause(sign(GATE))).rejects.toThrow("run store down");
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a template that cannot be read for the question fails closed too", async () => {
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("template store down"));
    await pause(undefined);
    expect(transitions().map((m) => m.to)).toEqual(["failed"]);
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("with no attestation key on the host, a publishing template's pause cannot verify and fails", async () => {
    delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    try {
      await pause(sign(GATE));
      expect(transitions().map((m) => m.to)).toEqual(["failed"]);
      expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    } finally {
      process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
    }
  });
});

describe("every other pause keeps today's road", () => {
  it.each([
    ["no claim, no publishing steps", [], undefined],
    ["no claim, a legacy template", null, undefined],
    ["a verified claim of another step on a publishing template", ["publish"], sign("review_step")],
  ])("%s: no decision, the interrupt is offered", async (_label, steps, claim) => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(steps as string[] | null));
    await pause(claim);
    expect(decisions.insertParkedDecision).not.toHaveBeenCalled();
    expect(transitions().map((m) => m.to)).not.toContain("failed");
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });
});
