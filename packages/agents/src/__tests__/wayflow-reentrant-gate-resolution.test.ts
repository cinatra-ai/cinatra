import { describe, it, expect, vi, beforeEach } from "vitest";

// #1625 / eng#548 (DESIGN-V3 contract (1)) — REPEAT-GATE-SAFETY.
//
// A single re-entrant InputMessageNode gate (the test-delivery agent's
// `test_form_gate`) is visited MORE THAN ONCE per run: the workflow loops
// send → gate → send → gate → continue. Each WayFlow input-required interrupt
// carries a FRESH taskId. Before the fix, `resolveWayflowXRenderer` mapped that
// taskId through a positional renderer-gate index (getOrAddWayflowRendererGateIndex):
// the 1st interrupt resolved index 0 → the real renderer, but the 2nd interrupt
// appended index 1, exhausted the single-step `childSteps` walk, and fell back to
// the SCHEMA-FIELD FALLBACK renderer — the regression this contract fixes.
//
// The fix is the SINGLE-RENDERER-GATE SHORT-CIRCUIT: when the compiled flow has
// exactly one xRenderer-bearing gate, resolution short-circuits to that one gate
// WITHOUT consulting the positional index — so every visit (1st, Nth, post-TTL,
// or under a Redis fault) resolves to the SAME real renderer.
//
// These tests drive the REAL `handleWayflowTaskState` resolution path (the
// resolver is module-internal); `onInterrupt`'s 2nd arg is the resolved
// xRenderer id.

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

// The single-renderer-gate short-circuit keeps the task→run reverse-map current
// via `rememberWayflowGateTask` (Redis). Spy on the a2a module so we can (a)
// prove the positional index is BYPASSED for a sole gate, and (b) simulate a
// Redis fault on the reverse-map write.
const a2aMock = vi.hoisted(() => {
  const rememberWayflowGateTask = vi.fn(async () => undefined);
  const getOrAddWayflowRendererGateIndex = vi.fn(async () => 0);
  return { rememberWayflowGateTask, getOrAddWayflowRendererGateIndex };
});
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberWayflowGateTask: a2aMock.rememberWayflowGateTask,
    getOrAddWayflowRendererGateIndex: a2aMock.getOrAddWayflowRendererGateIndex,
  };
});

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const SOLE_RENDERER_ID = "@cinatra-ai/email-test-delivery-agent:input";
const FALLBACK_RENDERER_ID = "@cinatra-ai/agent-builder:schema-field-fallback";

function makeRun(): AgentRunRecord {
  return {
    id: "run-td-1",
    templateId: "tmpl-td",
    versionId: null,
    runBy: "user-a",
    status: "running",
    inputParams: { campaignId: "c1" },
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
    oboCeiling: null,
    dependentInstallId: null,
  };
}

// A template whose compiled approvalPolicy has EXACTLY ONE xRenderer-bearing
// gate — the test-delivery agent class the short-circuit is sound for.
function makeSoleGateTemplate() {
  return {
    id: "tmpl-td",
    orgId: null,
    creatorId: null,
    name: "Email Test Delivery",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: {}, required: [] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: "@cinatra-ai/email-test-delivery-agent",
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: {
      steps: [
        {
          stepNumber: 1,
          requiresApproval: true,
          hitlOwnedBy: "self",
          xRenderer: SOLE_RENDERER_ID,
          firesRendererGate: true,
          schema: { properties: { recipientEmail: { type: "string" } } },
        },
      ],
    },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

// A distinct WayFlow interrupt: a fresh taskId, non-context payload (so the
// resolver takes the approvalPolicy path, not the context-selector branch).
function sendInterruptTask(taskId: string) {
  return {
    id: taskId,
    contextId: "ctx-td",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [],
  };
}

function resolvedRendererFor(callIndex: number): string {
  return onInterruptSpy.mock.calls[callIndex]![1] as string;
}

describe("execution.ts — single re-entrant gate resolution (#1625 contract (1))", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    a2aMock.rememberWayflowGateTask.mockResolvedValue(undefined);
    a2aMock.getOrAddWayflowRendererGateIndex.mockResolvedValue(0);
    storeMock.readAgentTemplateById.mockResolvedValue(makeSoleGateTemplate());
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
  });

  it("interrupt #1 (first send) resolves the real renderer, NOT the fallback", async () => {
    const run = makeRun();
    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: sendInterruptTask("task-send-1"),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(resolvedRendererFor(0)).toBe(SOLE_RENDERER_ID);
    expect(resolvedRendererFor(0)).not.toBe(FALLBACK_RENDERER_ID);
  });

  it("interrupt #2 (re-entry, fresh taskId) resolves the SAME renderer — the core regression", async () => {
    const run = makeRun();
    // Two-send sequence: distinct taskIds, same sole gate. Before the fix, the
    // 2nd interrupt's positional index (1) exhausted the single-step walk and
    // fell to the fallback.
    await handleWayflowTaskState({
      runId: run.id, run, fromStatus: "pending_approval",
      task: sendInterruptTask("task-send-1"),
    });
    await handleWayflowTaskState({
      runId: run.id, run, fromStatus: "pending_approval",
      task: sendInterruptTask("task-send-2"),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(2);
    expect(resolvedRendererFor(0)).toBe(SOLE_RENDERER_ID);
    expect(resolvedRendererFor(1)).toBe(SOLE_RENDERER_ID);
  });

  it("BYPASSES the positional renderer-gate index for a sole gate (TTL-reset immune)", async () => {
    const run = makeRun();
    await handleWayflowTaskState({
      runId: run.id, run, fromStatus: "pending_approval",
      task: sendInterruptTask("task-send-1"),
    });
    await handleWayflowTaskState({
      runId: run.id, run, fromStatus: "pending_approval",
      task: sendInterruptTask("task-send-2"),
    });
    // The short-circuit never consults the positional index, so a 7-day gate-list
    // TTL expiry (which would reset the index to 0 and, in a multi-gate flow,
    // mis-select an earlier renderer) is structurally irrelevant here.
    expect(a2aMock.getOrAddWayflowRendererGateIndex).not.toHaveBeenCalled();
    // The task→run reverse-map is still kept current for resume lookups.
    expect(a2aMock.rememberWayflowGateTask).toHaveBeenCalled();
  });

  it("resolves the sole renderer even under a Redis fault (never the fallback)", async () => {
    const run = makeRun();
    // Simulate Redis unavailable on the reverse-map write. The short-circuit must
    // still resolve the one possible renderer.
    a2aMock.rememberWayflowGateTask.mockRejectedValue(new Error("redis unavailable"));
    await handleWayflowTaskState({
      runId: run.id, run, fromStatus: "running",
      task: sendInterruptTask("task-send-1"),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(resolvedRendererFor(0)).toBe(SOLE_RENDERER_ID);
    expect(resolvedRendererFor(0)).not.toBe(FALLBACK_RENDERER_ID);
  });

  it("interrupt #3 (continue / terminal resolve) still resolves the sole renderer", async () => {
    const run = makeRun();
    // The terminal 'continue' visit is the same gate node re-entered a final time
    // before the workflow branches to end; it must resolve the same renderer.
    for (const taskId of ["task-send-1", "task-send-2", "task-continue"]) {
      await handleWayflowTaskState({
        runId: run.id, run, fromStatus: "pending_approval",
        task: sendInterruptTask(taskId),
      });
    }
    expect(onInterruptSpy).toHaveBeenCalledTimes(3);
    expect(resolvedRendererFor(2)).toBe(SOLE_RENDERER_ID);
  });
});
