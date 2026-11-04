/**
 * cinatra#4424 — a repair run gets the reviewer's findings in the input that
 * the template it EXECUTES declares.
 *
 * The dispatch drain (`lifecycle-repair-dispatch-store.ts`) projects the
 * findings under the declaration it reads when it creates the run. The worker
 * (`runAgentBuilderExecutionJob`, `execution.ts`) loads the live template
 * later. Between the two, the template can be re-imported with another
 * declaration: a crash between run creation and enqueue, then a re-drain that
 * finds the existing deterministic run and enqueues it as it is; or a queued
 * run that waits while an agent release changes. The run start re-derives the
 * findings input from the template it loaded and writes the difference before
 * any gate reads the inputs.
 *
 * Only the persistence, queue and event ports are replaced; the worker, the
 * compiled-lifecycle reader and the findings projection execute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  updateAgentRunInputParams: vi.fn(),
  transitionRunStatus: vi.fn(
    async (_runId: string, _from: string, _to: string, ..._rest: unknown[]): Promise<void> => {},
  ),
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
  setAgentRunTokenHash: vi.fn(async () => undefined),
  writeDurableHitlGateArtifact: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));
// The install-scope gate reads the database; its own behavior is proven in
// agent-run-scope-guard.test.ts.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  describeWayflowDispatchError: vi.fn((e: unknown) => String(e)),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, rememberLatestWayflowGateTask: vi.fn(async () => undefined) };
});
// Every case below stops at the per-field setup gate (the required `brief` is
// never supplied), so no dispatch branch runs. The gate's read-back answers
// the synthetic setup gate id so the park reaches its verified transition.
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: vi.fn(async () => undefined),
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    readLatestAgUiInterrupt: vi.fn(async (runId: string) => ({
      reviewTaskId: `setup-${runId}`,
      xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
    })),
    DualAdapterDispatch: class MockDualAdapterDispatch {
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

import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "lifecycle-repair-run:repair-4424";
const finding = { id: "finding-current", path: "title", message: "Use the current reviewed title", severity: "minor" };
/** The generic findings text (`buildRepairFindingsText`), spelled out. */
const FINDINGS_TEXT = "A reviewer requested changes to the work you produced. Apply the following requested changes:"
  + "\n\n1. Use the current reviewed title (field: title)";
/** What the CMS bridge put into `instructions` when the drain dispatched the
 * run under a template that declared nothing. */
const BRIDGE_TEXT = "Apply the reviewer's requested changes to the captured page: Use the current reviewed title";

function request() {
  return {
    kind: "lifecycle_repair_request", repairId: "repair-4424", gateId: "gate-4424", lineageId: "lineage-4424",
    attempt: 1, baseTarget: { artifactId: "artifact-base", representationRevisionId: "revision-base" },
    expectedBaseRevisionId: "revision-base", findings: [finding], continuationMode: "async_effects_gated",
    continuationAddress: null, originatingRunBy: "human-origin",
  };
}

function makeRun(inputParams: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID, templateId: "tmpl-4424", versionId: null, runBy: "human-origin", status: "queued",
    inputParams, stepResults: null, startedAt: null, completedAt: null, error: null, title: null,
    createdAt: new Date("2026-01-01"), sourceType: "lifecycle_repair", sourceId: null, packageVersion: null,
    // The fixture keeps the run fields this rule does not read at the values of
    // the setup-gate harness (execution-setup-gate-stale-park.test.ts).
    a2aTaskId: null, a2aContextId: null, parentRunId: null, agUiEnabled: null, lgThreadId: null,
    traceId: null, timeoutSeconds: null, streamedText: null, authPolicy: null, orgId: "org-4424",
    projectId: null, idempotencyKey: null, oboCeiling: null, dependentInstallId: null,
    humanPresent: true, executionAttemptId: null, ...overrides,
  };
}

function makeTemplate(lifecycleConfig: string | null, properties: Record<string, unknown> = {}) {
  return {
    id: "tmpl-4424", orgId: "org-4424", creatorId: null, name: "Repair Producer Fixture", description: "",
    sourceNl: "", compiledPlan: [],
    inputSchema: {
      properties: { instructions: { type: "string" }, prompt: { type: "string" }, brief: { type: "string" }, ...properties },
      required: ["brief"],
    },
    outputSchema: null, taskSpec: null, status: "published", packageName: null, packageVersion: null,
    gatedSteps: [], triggerMode: "full", approvalPolicy: null, agentDependencies: null, lifecycleConfig,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  };
}

const declares = (input: string) => JSON.stringify({ repairCapable: true, repairFindingsInput: { input } });

/** Every (from, to) pair transitionRunStatus was asked for. */
function edges(): string[] {
  return storeMock.transitionRunStatus.mock.calls.map((call) => {
    const args = call as unknown as unknown[];
    return `${String(args[1])}->${String(args[2])}`;
  });
}

function arrange(run: ReturnType<typeof makeRun>, template: ReturnType<typeof makeTemplate>) {
  storeMock.readAgentRunById.mockResolvedValue(run);
  storeMock.readAgentTemplateById.mockResolvedValue(template);
  storeMock.updateAgentRunInputParams.mockImplementation(async (_runId: string, partial: Record<string, unknown>) => ({
    ...run, inputParams: { ...run.inputParams, ...partial },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.transitionRunStatus.mockImplementation(async () => {});
});

describe("a repair run gets the findings in the input the template it executes declares (cinatra#4424)", () => {
  it("a re-drained run created before the template declared its input gets the findings text there at start", async () => {
    // The crash/re-drain window: the run was created while the template
    // declared nothing (the CMS bridge wrote `instructions`), the template was
    // re-imported declaring `instructions`, and the re-drain enqueued the
    // existing run without rebuilding its inputs.
    const inputs = { instanceId: "cms-site", instructions: BRIDGE_TEXT, task: BRIDGE_TEXT, lifecycleRepairRequest: request() };
    arrange(makeRun(inputs), makeTemplate(declares("instructions")));

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");

    expect(storeMock.updateAgentRunInputParams).toHaveBeenCalledOnce();
    expect(storeMock.updateAgentRunInputParams).toHaveBeenCalledWith(RUN_ID, { instructions: FINDINGS_TEXT });
    expect(edges()).toEqual(["queued->pending_approval"]);
  });

  it("a declaration changed from one input to another between dispatch and start moves the findings text to the new input", async () => {
    const inputs = { instructions: FINDINGS_TEXT, lifecycleRepairRequest: request() };
    arrange(makeRun(inputs), makeTemplate(declares("prompt")));

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");

    expect(storeMock.updateAgentRunInputParams).toHaveBeenCalledOnce();
    expect(storeMock.updateAgentRunInputParams).toHaveBeenCalledWith(RUN_ID, { prompt: FINDINGS_TEXT });
    expect(edges()).toEqual(["queued->pending_approval"]);
  });

  it("a run whose findings input cannot be written lands failed, naming the input, and runs no gate", async () => {
    const inputs = { instructions: "Old producing instructions", lifecycleRepairRequest: request() };
    arrange(makeRun(inputs), makeTemplate(declares("instructions")));
    storeMock.updateAgentRunInputParams.mockRejectedValue(new Error("write refused"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");
    } finally {
      error.mockRestore();
    }

    expect(edges()).toEqual(["queued->failed"]);
    const failure = storeMock.transitionRunStatus.mock.calls[0] as unknown as [string, string, string, { error: string }];
    expect(failure[3].error).toContain('"instructions"');
    expect(failure[3].error).toContain("write refused");
  });

  // Guards: these hold before and after the change.
  it("writes nothing when the declared input already carries the findings text", async () => {
    arrange(makeRun({ instructions: FINDINGS_TEXT, lifecycleRepairRequest: request() }), makeTemplate(declares("instructions")));
    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");
    expect(storeMock.updateAgentRunInputParams).not.toHaveBeenCalled();
    expect(edges()).toEqual(["queued->pending_approval"]);
  });

  it("writes nothing for a template that declares no findings input: the run starts with the inputs it was dispatched with", async () => {
    for (const lifecycleConfig of [null, JSON.stringify({ repairCapable: true }), "{not json",
      declares("lifecycleRepairRequest"), JSON.stringify({ repairFindingsInput: "instructions" })]) {
      storeMock.updateAgentRunInputParams.mockClear();
      arrange(makeRun({ instructions: BRIDGE_TEXT, lifecycleRepairRequest: request() }), makeTemplate(lifecycleConfig));
      await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");
      expect(storeMock.updateAgentRunInputParams).not.toHaveBeenCalled();
    }
  });

  it("writes nothing for a run that is not a lifecycle repair, even when its inputs carry a repair request", async () => {
    arrange(
      makeRun({ instructions: "A person's request", lifecycleRepairRequest: request() }, { sourceType: "agent_builder" }),
      makeTemplate(declares("instructions")),
    );
    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");
    expect(storeMock.updateAgentRunInputParams).not.toHaveBeenCalled();
  });

  it("a declared input that the template types as an object fails the run at start, naming the input", async () => {
    arrange(
      makeRun({ instructions: FINDINGS_TEXT, lifecycleRepairRequest: request() }),
      makeTemplate(declares("instructions"), { instructions: { type: "object" } }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-4424");
    } finally {
      error.mockRestore();
    }
    expect(edges()).toEqual(["queued->failed"]);
    const failure = storeMock.transitionRunStatus.mock.calls[0] as unknown as [string, string, string, { error: string }];
    expect(failure[3].error).toContain('input "instructions" is declared type "object"');
  });
});
