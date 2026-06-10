import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Capture spies with vi.hoisted() so they are accessible inside vi.mock()
// factory functions (vi.mock is hoisted above imports, so top-level vars
// declared with `const` are not yet initialized when the factory runs).
// ---------------------------------------------------------------------------
const { enrichSpy, onInterruptSpy } = vi.hoisted(() => {
  const enrichSpy = vi.fn(async (schema: unknown) => ({
    ...(schema as object),
    __enriched: true,
  }));
  const onInterruptSpy = vi.fn();
  return { enrichSpy, onInterruptSpy };
});

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // Replace only the enricher and the adapter dispatcher.
  // Keep real AgUiAdapter, A2UiAdapter, publishAgUiEvent, publishA2UiEvent so
  // the `new AgUiAdapter(...)` and `new A2UiAdapter(...)` constructor calls
  // in execution.ts succeed (they need to be real classes).
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

// ---------------------------------------------------------------------------
// Store mock — readAgentRunById, readAgentTemplateById, transitionRunStatus,
// updateAgentRunA2ATaskId, updateAgentRunA2AContextId.
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
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

// Trigger gate + skill autosave — never reached in the setup-interrupt paths.
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));

import { runAgentBuilderExecutionJob, handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRun(
  overrides: Partial<{
    id: string;
    templateId: string;
    runBy: string | null;
    inputParams: Record<string, unknown>;
  }> = {},
): AgentRunRecord {
  return {
    id: overrides.id ?? "run-test-1",
    templateId: overrides.templateId ?? "tmpl-1",
    versionId: null,
    runBy: overrides.runBy !== undefined ? overrides.runBy : "user-a",
    status: "queued",
    inputParams: overrides.inputParams ?? {},
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
    // Per-run AgentAuthPolicy override (null = inherit).
    authPolicy: null,
    // org id is required because the column is NOT NULL. Test fixtures use a
    // stable value; the field is not load-bearing for the execution-enrichment
    // paths under test.
    orgId: "org-test",
    // projectId is part of AgentRunRecord; tests don't exercise project
    // scoping so a stable null is correct.
    projectId: null,
    // Idempotent agent-task dispatch provenance (null = not a workflow run).
    idempotencyKey: null,
    workflowId: null,
    workflowTaskId: null,
  };
}

function makeTemplate(inputSchema: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Test Agent",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema,
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: null,
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: null,
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("execution.ts — enrichment call sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Deep spy: marks the envelope AND every inner property with __enriched so
    // both the grouped path (which receives a full object schema) and the
    // per-field path (which now wraps fieldSchema in an envelope and extracts
    // the inner property back out) can assert { __enriched: true }.
    enrichSpy.mockImplementation(async (schema: unknown) => {
      const s = schema as Record<string, unknown>;
      if (s.properties && typeof s.properties === "object") {
        const enrichedInner: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
          enrichedInner[k] = { ...(v as object), __enriched: true };
        }
        return { ...s, properties: enrichedInner, __enriched: true };
      }
      return { ...s, __enriched: true };
    });
    onInterruptSpy.mockReset();
    // Restore transitionRunStatus default (no-op).
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Call site 2 — per-field setup interrupt (execution.ts line ~698)
  // -----------------------------------------------------------------------
  it("per-field setup interrupt is enriched", async () => {
    const run = makeRun({ runBy: "user-a" });
    storeMock.readAgentRunById.mockResolvedValue(run);
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({
        properties: {
          website: {
            type: "string",
            title: "Website",
            // No x-renderer → per-field path (not grouped).
          },
        },
        required: ["website"],
      }),
    );

    await runAgentBuilderExecutionJob({ runId: run.id }, "job-1");

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    // Enricher must be called with the object-schema envelope (not the flat property).
    expect(enrichSpy.mock.calls[0]![0]).toMatchObject({
      type: "object",
      properties: { website: expect.objectContaining({ type: "string" }) },
    });
    expect((enrichSpy.mock.calls[0] as unknown[])[1]).toEqual({
      userId: "user-a",
      // Transport-registration cutover: execution injects the host email-send capability resolver so the
      // enricher resolves sender aliases registration-driven.
      resolveEmailSendProviders: expect.any(Function),
    });
    // onInterrupt receives the extracted inner property (with __enriched from deep spy).
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy.mock.calls[0]![0]).toMatchObject({ __enriched: true });
  });

  // -----------------------------------------------------------------------
  // Call site 3 — grouped setup interrupt (execution.ts line ~750)
  // -----------------------------------------------------------------------
  it("grouped setup interrupt is enriched", async () => {
    const run = makeRun({ runBy: "user-a" });
    storeMock.readAgentRunById.mockResolvedValue(run);
    // Grouped path: >=2 pending required fields + at least one has
    // "x-renderer": "@cinatra-ai/agent-builder:grouped-setup-form" (opt-in).
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({
        properties: {
          website: {
            type: "string",
            title: "Website",
            "x-renderer": "@cinatra-ai/agent-builder:grouped-setup-form",
          },
          senderEmail: {
            type: "string",
            title: "Sender email",
          },
        },
        required: ["website", "senderEmail"],
      }),
    );

    await runAgentBuilderExecutionJob({ runId: run.id }, "job-1");

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect((enrichSpy.mock.calls[0] as unknown[])[1]).toEqual({
      userId: "user-a",
      // Transport-registration cutover: execution injects the host email-send capability resolver so the
      // enricher resolves sender aliases registration-driven.
      resolveEmailSendProviders: expect.any(Function),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy.mock.calls[0]![0]).toMatchObject({ __enriched: true });
  });

  // -----------------------------------------------------------------------
  // Call site 1 — WayFlow input-required interrupt (execution.ts line ~301)
  // -----------------------------------------------------------------------
  it("WayFlow input-required interrupt is enriched", async () => {
    const run = makeRun({ runBy: "user-a" });
    // Template with no pending required fields (all resolved) so the setup
    // interrupt loop falls through; we call handleWayflowTaskState directly
    // to drive call site 1.
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate(
        { properties: {}, required: [] },
        { approvalPolicy: { steps: [] } },
      ),
    );
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);

    const task = {
      id: "task-wf-1",
      contextId: "ctx-1",
      status: {
        state: "input-required",
        message: { parts: [] },
      },
      metadata: {
        pendingApproval: {
          type: "object",
          properties: {
            confirmRecipients: { type: "boolean", title: "Confirm" },
          },
        },
      },
      history: [],
    };

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task,
    });

    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect((enrichSpy.mock.calls[0] as unknown[])[1]).toEqual({
      userId: "user-a",
      // Transport-registration cutover: execution injects the host email-send capability resolver so the
      // enricher resolves sender aliases registration-driven.
      resolveEmailSendProviders: expect.any(Function),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy.mock.calls[0]![0]).toMatchObject({ __enriched: true });
  });
});
