import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#3745 — when a run pauses for a review, the application records which
// step of the flow paused it. The flow runtime signs the pausing step's id and
// puts the claim on the metadata of the last agent message
// (`metadata.cinatra_gate_node`); the interrupt handler reads it and stores it
// beside the gate's task id through the a2a gate store, as signed. The record
// is best-effort: a store fault is logged and the interrupt proceeds as it
// does without a claim. These tests drive the real handleWayflowTaskState.

const { enrichSpy, onInterruptSpy } = vi.hoisted(() => {
  const enrichSpy = vi.fn(async (schema: unknown) => ({ ...(schema as object) }));
  const onInterruptSpy = vi.fn();
  return { enrichSpy, onInterruptSpy };
});

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: enrichSpy,
    // The park seam reads the emitted gate back through this reader before a run
    // may enter `pending_approval`. Serve it from the adapter spy: the suite
    // stays hermetic (no Redis) and still drives the real verification.
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
  rememberLatestWayflowGateTask: vi.fn<(runId: string, taskId: string) => Promise<void>>(
    async () => undefined,
  ),
  rememberWayflowGateNodeClaim: vi.fn<
    (runId: string, taskId: string, claim: unknown) => Promise<void>
  >(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ...gateStore };
});

import * as execution from "../execution";
import { handleWayflowTaskState } from "../execution";
const TEST_AUTHORITY = { orgId: "org-1", can: () => true };
import type { AgentRunRecord } from "../store";

function makeRun(inputParams: Record<string, unknown> = {}): AgentRunRecord {
  return {
    id: "run-ctx-1",
    templateId: "tmpl-1",
    versionId: null,
    runBy: "user-a",
    status: "running",
    inputParams,
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
    humanPresent: null, // presence discriminator (headless fixture)
    // lifecycle moment triple — a fixture run is at no moment.
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
    executionAttemptId: null,
  };
}

function makeTemplate() {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Context Agent",
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
    triggerMode: "none",
    approvalPolicy: { steps: [] },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

type HistoryMessage = { role?: string; parts?: readonly unknown[]; metadata?: unknown };
const helpers = execution as unknown as {
  extractCinatraGateNodeClaim: (
    history: ReadonlyArray<HistoryMessage> | undefined,
  ) => { node: string; attestation: string } | null;
  stripCinatraGateNodeClaims: (
    history: ReadonlyArray<HistoryMessage> | undefined,
  ) => ReadonlyArray<HistoryMessage> | undefined;
};

const CLAIM = { node: "review-step-node", attestation: "g1:" + "ab".repeat(32) };

function pausedTask(history: HistoryMessage[]) {
  return {
    id: "task-gate-1",
    contextId: "ctx-gate-1",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history,
  };
}

function agentMessage(metadata?: unknown): HistoryMessage {
  return {
    role: "agent",
    parts: [{ kind: "text", text: "Ready for review." }],
    ...(metadata === undefined ? {} : { metadata }),
  };
}

describe("execution.ts — the recorded pause step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
    gateStore.rememberLatestWayflowGateTask.mockResolvedValue(undefined);
    gateStore.rememberWayflowGateNodeClaim.mockResolvedValue(undefined);
  });

  // (x1)
  it("records the runtime's claim for the run and the gate task after the gate task", async () => {
    const run = makeRun();
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: pausedTask([agentMessage({ cinatra_gate_node: CLAIM, other: 1 })]),
    });
    expect(gateStore.rememberWayflowGateNodeClaim).toHaveBeenCalledTimes(1);
    expect(gateStore.rememberWayflowGateNodeClaim).toHaveBeenCalledWith(run.id, "task-gate-1", CLAIM);
    const latestOrder = gateStore.rememberLatestWayflowGateTask.mock.invocationCallOrder[0]!;
    const claimOrder = gateStore.rememberWayflowGateNodeClaim.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeGreaterThan(latestOrder);
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });

  // (x2)
  it("records nothing without a claim or with a claim of another shape, and the interrupt proceeds", async () => {
    const histories: HistoryMessage[][] = [
      [agentMessage()],
      [agentMessage({})],
      [agentMessage({ cinatra_gate_node: { node: 7, attestation: CLAIM.attestation } })],
      [agentMessage({ cinatra_gate_node: { node: CLAIM.node } })],
      [agentMessage({ cinatra_gate_node: "review-step-node" })],
      [agentMessage("not-an-object")],
      [agentMessage({ cinatra_gate_node: CLAIM }), agentMessage()],
    ];
    for (const history of histories) {
      vi.clearAllMocks();
      const run = makeRun();
      await handleWayflowTaskState({
        authority: TEST_AUTHORITY,
        runId: run.id,
        run,
        fromStatus: "running",
        task: pausedTask(history),
      });
      expect(gateStore.rememberWayflowGateNodeClaim).not.toHaveBeenCalled();
      expect(gateStore.rememberLatestWayflowGateTask).toHaveBeenCalledTimes(1);
      expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    }
  });

  // (x3)
  it("a record that throws is logged and the interrupt proceeds", async () => {
    gateStore.rememberWayflowGateNodeClaim.mockRejectedValueOnce(new Error("store unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const run = makeRun();
      await handleWayflowTaskState({
        authority: TEST_AUTHORITY,
        runId: run.id,
        run,
        fromStatus: "running",
        task: pausedTask([agentMessage({ cinatra_gate_node: CLAIM })]),
      });
      expect(gateStore.rememberWayflowGateNodeClaim).toHaveBeenCalledTimes(1);
      expect(onInterruptSpy).toHaveBeenCalledTimes(1);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("[wayflow-gate-node]")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // (x4)
  it("the pure reader answers the claim of the last agent message and null for other shapes", () => {
    expect(helpers.extractCinatraGateNodeClaim([agentMessage({ cinatra_gate_node: CLAIM })])).toEqual(CLAIM);
    expect(
      helpers.extractCinatraGateNodeClaim([
        agentMessage({ cinatra_gate_node: { ...CLAIM, extra: "x" } }),
        { role: "user", parts: [] },
      ]),
    ).toEqual(CLAIM);
    for (const history of [
      undefined,
      [],
      [agentMessage()],
      [agentMessage(null)],
      [agentMessage([CLAIM])],
      [agentMessage({ cinatra_gate_node: null })],
      [agentMessage({ cinatra_gate_node: { node: "", attestation: CLAIM.attestation } })],
      [agentMessage({ cinatra_gate_node: { node: CLAIM.node, attestation: "" } })],
      [agentMessage({ cinatra_gate_node: { node: CLAIM.node, attestation: 5 } })],
      [agentMessage({ cinatra_gate_node: CLAIM }), agentMessage({})],
      [{ role: "user", parts: [], metadata: { cinatra_gate_node: CLAIM } }],
    ] as Array<HistoryMessage[] | undefined>) {
      expect(helpers.extractCinatraGateNodeClaim(history)).toBeNull();
    }
  });

  // Stored step history keeps its messages and drops only the claim.
  it("the stored history drops the claim and keeps every message and its other metadata", () => {
    const plain = agentMessage();
    const withOther = agentMessage({ keep: "yes" });
    const withClaim = agentMessage({ cinatra_gate_node: CLAIM, keep: "also" });
    const onlyClaim = agentMessage({ cinatra_gate_node: CLAIM });
    const stripped = helpers.stripCinatraGateNodeClaims([plain, withOther, withClaim, onlyClaim])!;
    expect(stripped).toHaveLength(4);
    expect(stripped[0]).toBe(plain);
    expect(stripped[1]).toBe(withOther);
    expect(stripped[2]).toEqual({ ...withClaim, metadata: { keep: "also" } });
    expect(stripped[3]).toEqual({ role: "agent", parts: onlyClaim.parts });
    expect(withClaim.metadata).toEqual({ cinatra_gate_node: CLAIM, keep: "also" });
    expect(helpers.stripCinatraGateNodeClaims(undefined)).toBeUndefined();
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("@cinatra-ai/agent-ui-protocol/server");
  vi.doUnmock("../store");
  vi.doUnmock("../trigger-gate");
  vi.doUnmock("../skill-autosave");
  vi.doUnmock("../wayflow-url");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.resetModules();
});
