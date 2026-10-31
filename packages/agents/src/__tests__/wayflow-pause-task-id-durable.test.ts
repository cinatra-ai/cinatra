import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#4245 (spec 5.1) — the pause's task id is DURABLE where a change request
// depends on it. A paused run's column is the only thing a change request can trust,
// so at `input-required` the write is awaited with no catch, before the latest-task
// record and before any gate is published. And a sender that holds a claim writes
// only under its own token: 0 rows means the lease was taken over, and the run is
// someone else's.
//
// F1 and F2 drive the REAL `handleWayflowTaskState` with the mocks of
// `wayflow-reentrant-gate-resolution.test.ts`.

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
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: vi.fn(async () => ({ held: false, reason: "no-produced-output" })),
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
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
    // Hermetic: the F1 latest-task write is fail-closed real Redis at
    // interrupt-emit (execution.ts) — stub it so the unit test never opens a
    // real connection (it succeeds; the "Redis fault" cases fault only the
    // best-effort reverse-map write above).
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  };
});

import { handleWayflowTaskState } from "../execution";
// cinatra#1939 wave 2: handleWayflowTaskState now requires an org-write authority
// (§2d). transitionRunStatus is mocked here (no-op), so an inert member-shaped
// authority satisfies the type without affecting behavior.
const TEST_AUTHORITY = { orgId: "org-1", can: () => true };
import type { AgentRunRecord } from "../store";

const SOLE_RENDERER_ID = "@cinatra-ai/email-test-delivery-agent:input";

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
    producedReviewPark: null,
    authPolicy: null,
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: null, // cinatra#2067 presence discriminator (headless fixture)
    // cinatra#2928 lifecycle moment triple — a fixture run is at no moment.
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
    executionAttemptId: null,
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

describe("cinatra#4245 — the durable pause task id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentTemplateById.mockResolvedValue(makeSoleGateTemplate());
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue({ written: true } as never);
  });

  const pausedAt = (id: string) => ({
    authority: TEST_AUTHORITY,
    runId: "run-td-1",
    run: { ...makeRun(), a2aTaskId: "task-old" },
    fromStatus: "running" as const,
    task: sendInterruptTask(id),
  });

  it("F1: a write that fails at input-required throws, and no gate is published", async () => {
    storeMock.updateAgentRunA2ATaskId.mockRejectedValueOnce(new Error("db down") as never);
    await expect(handleWayflowTaskState(pausedAt("task-new"))).rejects.toThrow("db down");
    const { rememberLatestWayflowGateTask } = await import("@cinatra-ai/a2a");
    expect(rememberLatestWayflowGateTask).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("F2: a claimer taken over writes 0 rows and makes no transition, even for an unchanged id", async () => {
    storeMock.updateAgentRunA2ATaskId.mockResolvedValueOnce({ written: false } as never);
    await handleWayflowTaskState({ ...pausedAt("task-old"), pauseClaimToken: "tok-old" });
    expect(storeMock.updateAgentRunA2ATaskId).toHaveBeenCalledWith("run-td-1", "task-old", { pauseClaimToken: "tok-old" });
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("the park edge names the pause's task id", async () => {
    await handleWayflowTaskState({ ...pausedAt("task-new"), pauseClaimToken: "tok-live" });
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-td-1", "running", "pending_approval", { pauseTaskId: "task-new" }, TEST_AUTHORITY,
    );
  });

  it("guard (green at base): a write that fails at any other state stays best-effort", async () => {
    storeMock.updateAgentRunA2ATaskId.mockRejectedValueOnce(new Error("db down") as never);
    await handleWayflowTaskState({
      ...pausedAt("task-new"),
      task: { ...sendInterruptTask("task-new"), status: { state: "failed", message: { parts: [] } } },
    });
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-td-1", "running", "failed", expect.anything(), TEST_AUTHORITY,
    );
  });
});
