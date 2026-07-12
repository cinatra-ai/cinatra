import { describe, it, expect, vi, beforeEach } from "vitest";

// Generic interrupt-value pass-through: when the gate's
// upstream emitted a flat JSON object as the last agent message, execution.ts
// must spread its keys into the renderer values generically (NOT special-cased
// to the context selector). These tests drive the real handleWayflowTaskState.

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
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

import { handleWayflowTaskState } from "../execution";
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
    authPolicy: null,
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    workflowId: null,
    workflowTaskId: null,
    oboCeiling: null,
    dependentInstallId: null,
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

function taskWithAgentJson(json: unknown) {
  return {
    id: "task-ctx-1",
    contextId: "ctx-1",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [
      {
        role: "agent",
        parts: [{ kind: "text", text: JSON.stringify(json) }],
      },
    ],
  };
}

describe("execution.ts — generic interrupt-output spread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
  });

  it("spreads a context-selector JSON output → renderer receives candidates/selectedRefs/slotMeta", async () => {
    const run = makeRun();
    const payload = {
      candidates: [{ artifactId: "a1", representationRevisionId: "r1", semanticAssertionId: "s1" }],
      selectedRefs: [],
      slotMeta: { slotId: "offeringContext", resolutionMode: "accumulate", selectionMode: "interactive" },
    };
    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: taskWithAgentJson(payload),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(values.candidates).toEqual(payload.candidates);
    expect(values.selectedRefs).toEqual([]);
    expect(values.slotMeta).toEqual(payload.slotMeta);
    // reserved `output` carries the raw JSON string (never clobbered).
    expect(typeof values.output).toBe("string");
  });

  it("is generic: an arbitrary JSON object's keys are spread (not context-specific)", async () => {
    const run = makeRun();
    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: taskWithAgentJson({ widgets: [1, 2, 3], note: "hello" }),
    });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(values.widgets).toEqual([1, 2, 3]);
    expect(values.note).toBe("hello");
  });

  it("does NOT spread when output is prose+JSON (existing data-review gates unaffected)", async () => {
    const run = makeRun();
    const task = {
      id: "task-ctx-2",
      contextId: "ctx-2",
      status: { state: "input-required", message: { parts: [] } },
      metadata: {},
      history: [
        {
          role: "agent",
          parts: [{ kind: "text", text: 'Here are recipients: {"confirmedRecipients":[]}' }],
        },
      ],
    };
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    // No top-level confirmedRecipients spread — only `output` carries the prose.
    expect(values.confirmedRecipients).toBeUndefined();
    expect(typeof values.output).toBe("string");
  });

  it("parsed output does NOT clobber reserved `output`/`stepNumber`", async () => {
    const run = makeRun();
    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: taskWithAgentJson({ output: "INJECTED", stepNumber: 999, candidates: [] }),
    });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    // reserved output is the raw JSON string, not the injected "INJECTED".
    expect(values.output).not.toBe("INJECTED");
    expect(typeof values.output).toBe("string");
  });

  // #839: an InputMessageNode gate's declared DFE inputs (e.g. idea_selection_gate's
  // `ideas[]`) arrive via task.metadata.pendingApproval and must reach the renderer
  // EVEN WHEN history text is present (which otherwise wins the `output` slot).
  it("#839: surfaces a gate's pendingApproval inputs (ideas) alongside prose history", async () => {
    const run = makeRun();
    const ideas = [{ title: "Alpha" }, { title: "Beta" }];
    const task = {
      id: "task-idea-1",
      contextId: "ctx-idea-1",
      status: { state: "input-required", message: { parts: [] } },
      metadata: { pendingApproval: { ideas, agent_run_id: "run-ctx-1" } },
      // Non-JSON history: interruptOutput = this prose, spreadFromOutput = {},
      // so `ideas` is reachable ONLY via the pendingApproval gate-input merge.
      history: [
        { role: "agent", parts: [{ kind: "text", text: "Ideas are ready for review." }] },
      ],
    };
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(values.ideas).toEqual(ideas);
    expect(values.agent_run_id).toBe("run-ctx-1");
    // history-derived output is preserved (not clobbered by the gate inputs).
    expect(values.output).toBe("Ideas are ready for review.");
  });

  it("#839: strips host-reserved envelope keys from surfaced gate inputs", async () => {
    const run = makeRun();
    const task = {
      id: "task-idea-2",
      contextId: "ctx-idea-2",
      status: { state: "input-required", message: { parts: [] } },
      metadata: {
        pendingApproval: {
          ideas: [{ title: "Alpha" }],
          contentType: "evil",
          summary: "evil",
          contentBundle: { text: "evil" },
        },
      },
      history: [
        { role: "agent", parts: [{ kind: "text", text: "prose only" }] },
      ],
    };
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(values.ideas).toBeDefined();
    // Reserved envelope keys from pendingApproval must NOT leak in (they would
    // disable reviewer-output envelope synthesis / shadow a real bundle).
    expect(values.contentType).not.toBe("evil");
    expect(values.summary).not.toBe("evil");
    expect(values.contentBundle).toBeUndefined();
  });

  // #839: the strip must ALSO cover the history-EMPTY fallback, where
  // interruptOutput = JSON.stringify(pendingApproval) and spreadFromOutput
  // re-parses the whole (unfiltered) pendingApproval.
  it("#839: strips reserved keys even when history is empty (pendingApproval fallback)", async () => {
    const run = makeRun();
    const task = {
      id: "task-idea-3",
      contextId: "ctx-idea-3",
      status: { state: "input-required", message: { parts: [] } },
      metadata: {
        pendingApproval: {
          ideas: [{ title: "Alpha" }],
          contentType: "evil",
          summary: "evil",
          contentBundle: { text: "evil" },
        },
      },
      history: [], // EMPTY → spreadFromOutput = parsed pendingApproval (unfiltered)
    };
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task });
    const values = onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(values.ideas).toEqual([{ title: "Alpha" }]);
    expect(values.contentType).not.toBe("evil");
    expect(values.summary).not.toBe("evil");
    expect(values.contentBundle).toBeUndefined();
  });
});
