import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cinatra#3745 - the canonical first WayFlow dispatch selects the loader's
 * source for the dispatch context, binds it to the run's attempt and only then
 * sends; the first message names the bound source under the loader's fence key.
 *
 * The harness of execution-connector-instance-binding-4220.test.ts: every
 * store/db-reading seam the queued->running WayFlow leg reaches is mocked, so the
 * real runAgentBuilderExecutionJob runs with no database. Here the A2A client is
 * a double, and its sendTask rejects after it records the message: the send ends
 * the leg. What happens after the send is not what this suite pins.
 */

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  // cinatra#3089: a pause reads the steps its dispatch compiled from the mounted source; none until the test binds them.
  readRunPauseSteps: vi.fn(async (): Promise<unknown> => { throw new Error("no pause steps were compiled from the source bound to the run"); }),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
  selectWayflowRunStepToolPolicy: vi.fn(),
  bindRunStepToolPolicy: vi.fn(async () => undefined),
  CINATRA_EXPECTED_SOURCE_MESSAGE_KEY: "__cinatra_expected_source__",
}));
vi.mock("../store", () => storeMock);
// cinatra#3089: the steps the dispatch compiled from the mounted source and bound with it: here the template's policy as
// it was when the test bound it (a copy), never a later template read; with no policy, none compiled (the reader refuses).
function bindTemplate(t: unknown): void {
  storeMock.readAgentTemplateById.mockResolvedValue(t as never);
  const read = t as { approvalPolicy?: unknown } | null | undefined;
  if (read?.approvalPolicy === undefined || read.approvalPolicy === null) storeMock.readRunPauseSteps.mockRejectedValue(new Error("no pause steps were compiled from the source bound to the run"));
  else storeMock.readRunPauseSteps.mockResolvedValue({ approvalPolicy: structuredClone(read.approvalPolicy) });
}

vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: vi.fn(async () => ({ held: false, reason: "no-review" })),
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));

vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: vi.fn(async () => "queued") }));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: vi.fn(async () => undefined),
    readLatestAgUiInterrupt: vi.fn(async () => null),
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class {
      onInterrupt = vi.fn();
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
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: vi.fn(async () => []),
}));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({})),
}));
vi.mock("@/lib/org-write/dispatch-freeze", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => [] as string[]),
}));
vi.mock("@/lib/agent-run-skills-used", () => ({
  snapshotSkillsAtRunStart: vi.fn(async () => undefined),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
  replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
  readRunSelectedSkillRevisions: vi.fn(() => []),
}));
vi.mock("../recommendation-interception", async (orig) => ({
  ...(await orig<typeof import("../recommendation-interception")>()),
  autoApplyHeadlessRecommendation: vi.fn(async () => undefined),
}));
vi.mock("../input-schema-resolver", async (orig) => ({
  ...(await orig<typeof import("../input-schema-resolver")>()),
  resolveTemplateInputSchema: vi.fn(async () => ({ type: "object", required: [], properties: {} })),
  assertUnsatisfiableHiddenInputs: vi.fn(async () => undefined),
}));
// Partial mock, as in the 4220 suite: the dispatch's import chain loads
// register-host-connector-services, which needs the real exports at load.
vi.mock("@/lib/connector-instance-write-authority", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deriveAgentRunConnectorInstanceBinding: vi.fn(async () => null),
}));
vi.mock("../run-token-store", () => ({
  setAgentRunConnectorInstanceBinding: vi.fn(async () => undefined),
  setAgentRunTokenHash: vi.fn(async () => undefined),
  readAgentRunByTokenHash: vi.fn(async () => null),
  readAgentRunTokenHashById: vi.fn(async () => null),
}));
// No runtime request leaves the suite: undici's fetch refuses, and the A2A client is a double.
vi.mock("undici", async (orig) => ({
  ...(await orig<typeof import("undici")>()),
  fetch: vi.fn(async () => {
    throw new Error("runtime-contacted (test stop)");
  }),
}));
const sendTask = vi.hoisted(() => vi.fn(async (params: unknown) => {
  void params;
  throw new Error("sent (test stop)");
}));
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberWayflowGateTask: vi.fn(async () => undefined),
  rememberAnsweredGateSubmission: vi.fn(async () => undefined),
  getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
}));

import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "run-3745";

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    templateId: "tmpl-3745",
    status: "queued",
    inputParams: {},
    versionId: null,
    runBy: "user-1",
    orgId: "org-1",
    projectId: null,
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    timeoutSeconds: null,
    executionAttemptId: "attempt-1",
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeTemplate(): Record<string, unknown> {
  return {
    id: "tmpl-3745",
    orgId: null,
    name: "test-template",
    inputSchema: { type: "object", properties: {} },
    approvalPolicy: { steps: [] },
    status: "published",
    type: "leaf",
    packageName: "@cinatra/test-agent",
    packageVersion: "1.0.0",
    agentDependencies: {},
    hitlRequired: false,
    executionProvider: "wayflow",
    sourceType: "internal",
    agentUrl: null,
    triggerMode: "full",
    gatedSteps: [],
  };
}

const run = () => runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-3745").catch(() => undefined);

describe("cinatra#3745 - the first dispatch binds the executed source before it sends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindTemplate(makeTemplate());
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.selectWayflowRunStepToolPolicy.mockImplementation(async (input: { contextId: string }) => ({
      version: 1, contextId: input.contextId, source: "{}",
      sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
    }));
    storeMock.bindRunStepToolPolicy.mockResolvedValue(undefined);
  });

  it("selects the loader's source for the dispatch context and binds it to the run's attempt, then sends", async () => {
    await run();

    expect(storeMock.selectWayflowRunStepToolPolicy).toHaveBeenCalledTimes(1);
    const [selection] = storeMock.selectWayflowRunStepToolPolicy.mock.calls[0]! as unknown as [{ agentUrl: string; contextId: string }];
    expect(selection.agentUrl).toBe("http://wayflow.test");
    expect(storeMock.bindRunStepToolPolicy).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID, orgId: "org-1", executionAttemptId: "attempt-1",
      policy: expect.objectContaining({ contextId: selection.contextId }),
    }));
    expect(sendTask).toHaveBeenCalledTimes(1);
    const [message] = sendTask.mock.calls[0]! as unknown as [{ message: { contextId: string } }];
    expect(message.message.contextId).toBe(selection.contextId);
    expect(storeMock.bindRunStepToolPolicy.mock.invocationCallOrder[0]!).toBeLessThan(sendTask.mock.invocationCallOrder[0]!);
  });

  it("sends nothing when the loader answers without a binding, or the bind refuses", async () => {
    for (const refuse of [
      () => storeMock.selectWayflowRunStepToolPolicy.mockRejectedValueOnce(new Error("step_tool_loader_binding_missing")),
      () => storeMock.bindRunStepToolPolicy.mockRejectedValueOnce(new Error("step_tool_dispatch_rebind_refused")),
    ]) {
      sendTask.mockClear();
      refuse();
      await run();
      expect(sendTask).not.toHaveBeenCalled();
    }
  });

  it("sends nothing when the dispatching run carries no attempt", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ executionAttemptId: null }));
    await run();
    expect(storeMock.bindRunStepToolPolicy).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
  });
});

// cinatra#3745 dispatch fence: the first message names the bound source, so the
// loader's mount that receives it runs the task only for its own source.
describe("cinatra#3745 - the first message names the bound source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindTemplate(makeTemplate());
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.selectWayflowRunStepToolPolicy.mockImplementation(async (input: { contextId: string }) => ({
      version: 1, contextId: input.contextId, source: "{}",
      sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
    }));
    storeMock.bindRunStepToolPolicy.mockResolvedValue(undefined);
  });

  it("carries the three digests of the policy it bound under the loader's fence key", async () => {
    await run();

    const [{ policy }] = storeMock.bindRunStepToolPolicy.mock.calls[0]! as unknown as [{ policy: Record<string, unknown> }];
    const [sent] = sendTask.mock.calls[0]! as unknown as [{ message: { parts: Array<{ text: string }> } }];
    const payload = JSON.parse(sent.message.parts[0]!.text) as Record<string, unknown>;
    expect(payload.__cinatra_expected_source__).toEqual({
      sourceSha256: policy.sourceSha256, executedSourceSha256: policy.executedSourceSha256,
      declarationSourceSha256: policy.declarationSourceSha256,
    });
    expect(payload.cinatra_run_id).toBe(RUN_ID);
  });
});

// cinatra#4150 round 19, finding 2: the dispatch records the publish rows of the template object it runs, in the same
// queued -> running CAS, so a park later in this attempt labels its values by the plan it runs, never by a recompile.
describe("cinatra#4150 - the dispatch records the publish rows of the plan it runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.selectWayflowRunStepToolPolicy.mockImplementation(async (input: { contextId: string }) => ({
      version: 1, contextId: input.contextId, source: "{}",
      sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
    }));
    storeMock.bindRunStepToolPolicy.mockResolvedValue(undefined);
  });

  const dispatchOf = () => {
    const call = (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { dispatch?: Record<string, unknown> }]>)
      .find(([, from, to]) => from === "queued" && to === "running");
    return call?.[3]?.dispatch;
  };

  it("the queued -> running CAS carries the template's rows map as JSON, and {} for a template with none", async () => {
    const rows = { publish: [{ label: "Title", input: "title" }] };
    bindTemplate({ ...makeTemplate(), publishingSteps: ["publish"], publishRows: rows });
    await run();
    expect(dispatchOf()).toEqual({ attemptId: expect.any(String), publishRows: JSON.stringify(rows) });

    storeMock.transitionRunStatus.mockClear();
    bindTemplate({ ...makeTemplate(), publishRows: null });
    await run();
    expect(dispatchOf()).toEqual({ attemptId: expect.any(String), publishRows: "{}" });
  });
});

// cinatra#3089: the steps that classify a run's pauses are compiled at dispatch from the source the loader mounted and
// selected (its own file text, sent with the binding), by the installer's compile, and bound with that source. The
// template row may already show another version: an install writes the runtime files before the row and reloads the
// runtime only afterwards, best effort, and a reload can fail.
describe("cinatra#3089 - the dispatch binds the steps of the source the loader mounted", () => {
  const gate = (marked: boolean) => ({
    component_type: "InputMessageNode", id: "approval_gate", name: "approval_gate",
    metadata: { cinatra: { requiresApproval: true, ...(marked ? { artifactReview: { targetsInput: "reviewTargets" } } : {}) } },
    outputs: [{ title: "approval_gate_out", type: "string" }],
  });
  // A flow with one gate, marked for the per-artifact review or not (the shape of oas-compiler-artifact-review-marker).
  const oas = (marked: boolean) => JSON.stringify({
    agentspec_version: "26.1.0", component_type: "Flow", id: "review-flow", name: "Review Flow",
    metadata: { cinatra: { type: "flow" } }, inputs: [{ title: "reviewTargets", type: "array" }], outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [{ $component_ref: "startNode" }, { $component_ref: "approval_gate" }, { $component_ref: "endNode" }],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "startNode" }, to_node: { $component_ref: "approval_gate" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "approval_gate" }, to_node: { $component_ref: "endNode" } },
    ],
    $referenced_components: {
      startNode: { component_type: "StartNode", id: "startNode", name: "Setup", inputs: [{ title: "reviewTargets", type: "array" }],
        metadata: { cinatra: { required: [], hidden: ["reviewTargets"] } } },
      approval_gate: gate(marked),
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  });
  const rowSteps = (marked: boolean) => [{ stepNumber: 1, nodeType: "input_message", requiresApproval: true,
    ...(marked ? { artifactReviewTargetsInput: "reviewTargets" } : {}) }];
  const mounted = (source: string | undefined) => storeMock.selectWayflowRunStepToolPolicy.mockImplementation(
    async (input: { contextId: string }) => ({ version: 1, contextId: input.contextId, source: "{}",
      sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
      ...(source === undefined ? {} : { mountedSource: source }) }));
  const boundMarker = (call = 0) => {
    const [{ pauseSteps }] = storeMock.bindRunStepToolPolicy.mock.calls[call]! as unknown as [{ pauseSteps: { approvalPolicy: { steps: Array<Record<string, unknown>> } } | null }];
    return pauseSteps?.approvalPolicy.steps.find((st) => st.nodeType === "input_message")?.artifactReviewTargetsInput;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.bindRunStepToolPolicy.mockResolvedValue(undefined);
  });

  it("the row shows version 2 with the marker removed, the loader mounted version 1 with it: the marker is bound", async () => {
    bindTemplate({ ...makeTemplate(), packageVersion: "2.0.0", approvalPolicy: { steps: rowSteps(false) } });
    mounted(oas(true));
    await run();
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(boundMarker()).toBe("reviewTargets");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("the row shows version 1 with the marker, the loader mounted version 2 without it: no marker is bound", async () => {
    bindTemplate({ ...makeTemplate(), packageVersion: "1.0.0", approvalPolicy: { steps: rowSteps(true) } });
    mounted(oas(false));
    await run();
    const [{ pauseSteps }] = storeMock.bindRunStepToolPolicy.mock.calls[0]! as unknown as [{ pauseSteps: unknown }];
    expect(pauseSteps).not.toBeNull();
    expect(boundMarker()).toBeUndefined();
  });

  it("a failed reload keeps version 1 mounted after the row moved to version 2: every later dispatch binds version 1's steps", async () => {
    bindTemplate({ ...makeTemplate(), packageVersion: "2.0.0", approvalPolicy: { steps: rowSteps(false) } });
    mounted(oas(true));
    await run();
    await run();
    expect(storeMock.bindRunStepToolPolicy).toHaveBeenCalledTimes(2);
    expect([boundMarker(0), boundMarker(1)]).toEqual(["reviewTargets", "reviewTargets"]);
  });

  it("a loader that sends no mounted source: the bind records that no steps could be compiled, never the row's", async () => {
    bindTemplate({ ...makeTemplate(), approvalPolicy: { steps: rowSteps(true) } });
    mounted(undefined);
    await run();
    expect(storeMock.bindRunStepToolPolicy).toHaveBeenCalledWith(expect.objectContaining({ pauseSteps: null }));
  });
});
