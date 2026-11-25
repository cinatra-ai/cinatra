import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

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
  // cinatra#3089: a pause reads the steps its dispatch bound beside the source; none until the test binds them.
  readRunPauseSteps: vi.fn(async (): Promise<unknown> => { throw new Error("no settled pause steps are bound to the run"); }),
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
// cinatra#3089: what the dispatch bound for a pause: the template's policy as it was when the test bound it (a copy),
// never a later template read; a template with no policy binds none, and the reader refuses.
function bindTemplate(t: unknown): void {
  storeMock.readAgentTemplateById.mockResolvedValue(t as never);
  const read = t as { packageVersion?: string | null; approvalPolicy?: unknown } | null | undefined;
  if (read?.approvalPolicy === undefined || read.approvalPolicy === null) storeMock.readRunPauseSteps.mockRejectedValue(new Error("no settled pause steps are bound to the run"));
  else storeMock.readRunPauseSteps.mockResolvedValue({ packageVersion: read.packageVersion ?? null, approvalPolicy: structuredClone(read.approvalPolicy) });
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

// cinatra#3089: the dispatch runs the INSTALLED package (routed by its name), not the pinned
// snapshot. Version 2 is installed over version 1 and a run requests version 1: the runtime double answers the send
// with the pause the installed flow raised, and the real handler classifies it. The policy of a version that did not
// produce the pause never classifies it.
describe("cinatra#3089 - a pause is classified by the steps of the version that ran it", () => {
  const KEY = "test-gate-node-key-3089-dispatch";
  const savedKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
  const drafts = (marked: boolean) => ({
    stepNumber: 1, nodeType: "agent", requiresApproval: true, hitlOwnedBy: "self", gateCount: 1, xRenderer: "@test/drafting:review",
    inputMessageSchema: { type: "object", properties: { userResponse: { type: "string" } } }, surfaceGateInputKeys: ["reviewTargets"],
    ...(marked ? { artifactReviewTargetsInput: "reviewTargets", artifactReviewGateNode: "drafts-approval_gate" } : {}),
  });
  const pausedByInstalledFlow = () => {
    const sig = createHmac("sha256", KEY).update("g1\nctx-3089\ntask-3089\ndrafts-approval_gate").digest("hex");
    return {
      id: "task-3089", contextId: "ctx-3089",
      status: { state: "input-required", message: { parts: [] } },
      metadata: { pendingApproval: { type: "object", properties: { userResponse: { type: "string" } } } },
      history: [{ role: "agent", parts: [{ kind: "text", text: "Ready." }], metadata: { cinatra_gate_node: { node: "drafts-approval_gate", attestation: `g1:${sig}` } } }],
    };
  };
  async function dispatchPinnedToV1(installed: { version: string; marked: boolean }, v1Marked: boolean) {
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ versionId: "ver-1", packageVersion: "1.0.0", a2aContextId: "ctx-3089" }));
    bindTemplate({ ...makeTemplate(), packageVersion: installed.version, approvalPolicy: { steps: [drafts(installed.marked)] } });
    storeMock.readAgentTemplateVersionById.mockResolvedValue({ templateId: "tmpl-3745", semver: "1.0.0",
      snapshot: { name: "test-template", description: null, sourceNl: "", compiledPlan: [], inputSchema: { type: "object", properties: {} },
        outputSchema: null, approvalPolicy: { steps: [drafts(v1Marked)] }, type: "leaf", taskSpec: null, packageVersion: "1.0.0",
        lgGraphCode: null, lgGraphId: null } } as never);
    sendTask.mockImplementationOnce(async () => pausedByInstalledFlow() as never);
    await run();
  }
  const failedWith = (code: string) => (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, { error?: string }]>)
    .some(([id, from, to, patch]) => id === RUN_ID && from === "running" && to === "failed" && typeof patch?.error === "string" && patch.error.startsWith(`${code}: `));
  const parked = () => (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string]>)
    .some(([, , to]) => to === "pending_approval");

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
    storeMock.selectWayflowRunStepToolPolicy.mockImplementation(async (input: { contextId: string }) => ({
      version: 1, contextId: input.contextId, source: "{}",
      sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
    }));
    storeMock.bindRunStepToolPolicy.mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    else process.env.CINATRA_CONTEXT_ATTEST_KEY = savedKey;
  });

  it("version 2 installed over version 1, a run requesting version 1: version 1's review marker does not classify the pause; the run stops", async () => {
    await dispatchPinnedToV1({ version: "2.0.0", marked: false }, true);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(failedWith("PAUSE_POLICY_VERSION_MISMATCH")).toBe(true);
    expect(parked()).toBe(false);
  });

  it("a review marker only the installed version 2 carries is never degraded to an ordinary approval of version 1", async () => {
    await dispatchPinnedToV1({ version: "2.0.0", marked: true }, false);
    expect(failedWith("PAUSE_POLICY_VERSION_MISMATCH")).toBe(true);
    expect(parked()).toBe(false);
  });

  it("the dispatch hands the bind the template row it read before the selection, so the steps are bound beside the source", async () => {
    await dispatchPinnedToV1({ version: "2.0.0", marked: true }, false);
    expect(storeMock.bindRunStepToolPolicy).toHaveBeenCalledWith(expect.objectContaining({
      dispatchTemplateRead: { packageVersion: "2.0.0", approvalPolicy: { steps: [drafts(true)] } },
    }));
    expect(storeMock.bindRunStepToolPolicy.mock.invocationCallOrder[0]!).toBeGreaterThan(storeMock.selectWayflowRunStepToolPolicy.mock.invocationCallOrder[0]!);
  });

  it("the requested version is the installed one: the pause is classified as before, no version stop", async () => {
    await dispatchPinnedToV1({ version: "1.0.0", marked: false }, false);
    expect(sendTask).toHaveBeenCalledTimes(1);
    // Read twice: by the dispatch's overlay, then by the pause's classification.
    expect(storeMock.readAgentTemplateVersionById.mock.calls).toEqual([["ver-1"], ["ver-1"]]);
    expect(failedWith("PAUSE_POLICY_VERSION_MISMATCH")).toBe(false);
    expect(failedWith("PAUSE_POLICY_UNREAD")).toBe(false);
  });
});
