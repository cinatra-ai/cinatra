import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cinatra#4220 — the WayFlow dispatch derives the run's connector-instance
 * binding ONCE, from the run row's own start input `instanceId`, and records it
 * BEFORE anything is sent to the runtime. A refused binding fails the run with
 * the gate's reason and sends nothing; no binding leaves dispatch unchanged.
 *
 * The REAL createExternalA2AClient runs: the only stub is undici's fetch behind
 * it, so the suite observes the runtime contact itself (the agent-card request
 * the factory makes at once), not a mocked factory.
 *
 * Every store/db-reading seam the queued→running WayFlow leg reaches is mocked,
 * so the real runAgentBuilderExecutionJob runs with no database.
 */

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
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
}));
vi.mock("../store", () => storeMock);

const holdSpy = vi.hoisted(() =>
  vi.fn(async () => ({ held: false, reason: "no-review" }) as { held: boolean; reason: string }),
);
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: holdSpy,
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
// The real describeWayflowDispatchError runs, so a gate denial's message
// reaches the failed transition verbatim.
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({})),
}));

// The queued-dispatch leg's database readers (the recovery-sweep harness never
// reaches them: its leg returns at the hold recovery). Each value is built inside
// its factory and the real root-app module is never imported, as the
// external-A2A dispatch suite stubs the same seams.
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

const { deriveSpy, setBindingSpy } = vi.hoisted(() => ({
  deriveSpy: vi.fn(),
  setBindingSpy: vi.fn(async () => undefined),
}));
// Partial mock: the dispatch's import chain loads register-host-connector-services,
// which calls createInstanceWriteAuthorityService() at module load, so every real
// export stays; only the derivation is replaced.
vi.mock("@/lib/connector-instance-write-authority", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    deriveAgentRunConnectorInstanceBinding: deriveSpy,
  };
});
vi.mock("../run-token-store", () => ({
  setAgentRunConnectorInstanceBinding: setBindingSpy,
  setAgentRunTokenHash: vi.fn(async () => undefined),
  readAgentRunByTokenHash: vi.fn(async () => null),
  readAgentRunTokenHashById: vi.fn(async () => null),
}));

// Every request the dispatch makes to the runtime goes through undici's fetch
// (the WayFlow dispatcher wraps it); the real A2A client factory calls it first
// for the agent card. Rejecting it ends the leg at the first contact.
const fetchSpy = vi.hoisted(() => vi.fn(async (...args: unknown[]): Promise<Response> => {
  void args;
  throw new Error("runtime-contacted (test stop)");
}));
vi.mock("undici", async (orig) => ({
  ...(await orig<typeof import("undici")>()),
  fetch: fetchSpy,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRunIdByWayflowTaskId: vi.fn(async () => null),
    resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    rememberAnsweredGateSubmission: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});

import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "run-4220";
// The first runtime contact ends the leg: the dispatch catch fails the run.
// What happens AFTER that contact is not what this suite pins.

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    templateId: "tmpl-4220",
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
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeTemplate(): Record<string, unknown> {
  return {
    id: "tmpl-4220",
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
    gatedSteps: null,
  };
}

const failedCalls = () =>
  (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string, Record<string, unknown> | undefined]>)
    .filter((c) => c[1] === "running" && c[2] === "failed");

describe("cinatra#4220 — dispatch derives the run's connector-instance binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
  });

  it("(c) no binding: nothing is recorded and the runtime is contacted", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ inputParams: { instanceId: "wp-1" } }));
    deriveSpy.mockResolvedValue(null);

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-c");

    expect(setBindingSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("(a) derives from the run row's own start input and records it before the send", async () => {
    const inputParams = { instanceId: "wp-1" };
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ inputParams }));
    const binding = { connectorKey: "wordpress", instanceId: "wp-1" };
    deriveSpy.mockResolvedValue(binding);

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-a");

    expect(deriveSpy).toHaveBeenCalledTimes(1);
    expect(deriveSpy).toHaveBeenCalledWith({ runId: RUN_ID, runBy: "user-1", orgId: "org-1", inputParams });
    expect(setBindingSpy).toHaveBeenCalledTimes(1);
    expect(setBindingSpy).toHaveBeenCalledWith(RUN_ID, binding);
    expect(fetchSpy).toHaveBeenCalled();
    // The first runtime contact is the agent-card request, and it comes AFTER
    // the binding is recorded.
    expect(String(fetchSpy.mock.calls[0][0])).toContain("http://wayflow.test");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("agent-card");
    expect(setBindingSpy.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
  });

  it("(b) a refused binding fails the run with the gate's reason and contacts nothing (no agent-card request)", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun({ inputParams: { instanceId: "wp-other" } }));
    deriveSpy.mockRejectedValue(new Error("connector instance write denied: instance_org_mismatch"));

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-b");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setBindingSpy).not.toHaveBeenCalled();
    const failed = failedCalls();
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toBe(RUN_ID);
    expect(failed[0][3]).toEqual({ error: "connector instance write denied: instance_org_mismatch" });
  });
});
