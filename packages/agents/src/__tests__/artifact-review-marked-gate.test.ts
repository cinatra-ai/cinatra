import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#1796 (epic #1620 S13) — the execution.ts MARKED artifact-review gate.
//
// When an input-required gate carries the compiled `artifactReviewTargetsInput`
// marker, handleWayflowTaskState must (1) PIN the run's immutable review targets
// via emitArtifactReviewGate and (2) route the human to the generic review
// surface (the redirect renderer + reviewSurfaceUrl) INSTEAD of the legacy
// reviewer envelope. An UNMARKED gate must behave byte-identically.

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

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

// The pin primitive — mocked so this unit test never touches the DB. The error
// class is a real subclass so execution.ts's `instanceof` fail-open check works.
const gateStoreMock = vi.hoisted(() => {
  class ArtifactReviewGateError extends Error {
    code: "invalid-targets" | "pin-conflict";
    constructor(code: "invalid-targets" | "pin-conflict", msg: string) {
      super(msg);
      this.name = "ArtifactReviewGateError";
      this.code = code;
    }
  }
  return {
    emitArtifactReviewGate: vi.fn(
      async (): Promise<{
        gateId: string;
        targets: Array<{ artifactId: string; representationRevisionId: string }>;
        idempotent: boolean;
      }> => ({ gateId: "gate-1", targets: [], idempotent: false }),
    ),
    readReviewGate: vi.fn(async (): Promise<{ orgId: string; status: string } | null> => null),
    ArtifactReviewGateError,
  };
});
vi.mock("../artifact-review-gate-store", () => gateStoreMock);

// Hermetic Redis: the interrupt-emit path calls these @cinatra-ai/a2a helpers;
// stub them so no real Redis connection is opened.
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

function makeRun(inputParams: Record<string, unknown> = {}): AgentRunRecord {
  return {
    id: "run-rev-1",
    templateId: "tmpl-rev-1",
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
    orgId: "org-rev",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function makeTemplate(step: Record<string, unknown>) {
  return {
    id: "tmpl-rev-1",
    orgId: null,
    creatorId: null,
    name: "Reviewer",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: {}, required: [] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: "@cinatra-ai/reviewer-agent",
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: { steps: [step] },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

const MARKED_STEP = {
  stepNumber: 1,
  nodeType: "input_message",
  requiresApproval: true,
  hitlOwnedBy: "self",
  xRenderer: "@cinatra-ai/reviewer-agent:output",
  artifactReviewTargetsInput: "reviewTargets",
};
const UNMARKED_STEP = {
  stepNumber: 1,
  nodeType: "input_message",
  requiresApproval: true,
  hitlOwnedBy: "self",
  xRenderer: "@cinatra-ai/reviewer-agent:output",
};

const TARGETS = [
  { artifactId: "art-1", representationRevisionId: "rev-1" },
  { artifactId: "art-2", representationRevisionId: "rev-2" },
];

function inputRequiredTask(summaryText?: string) {
  return {
    id: "task-rev-1",
    contextId: "ctx-rev-1",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: summaryText
      ? [{ role: "agent", parts: [{ kind: "text", text: summaryText }] }]
      : [],
  };
}

describe("execution.ts — marked artifact-review gate (pin + route)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
    gateStoreMock.emitArtifactReviewGate.mockResolvedValue({
      gateId: "gate-1",
      targets: TARGETS,
      idempotent: false,
    });
  });

  it("pins the flow-input targets + routes to the generic review surface", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Two items ready for your review."),
    });

    // (1) Pinned with the run's immutable targets under the wayflow reviewTaskId.
    expect(gateStoreMock.emitArtifactReviewGate).toHaveBeenCalledTimes(1);
    expect(gateStoreMock.emitArtifactReviewGate).toHaveBeenCalledWith({
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1",
      targets: TARGETS,
    });

    // (2) Routed via the redirect renderer — NOT the legacy reviewer envelope.
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer, values, invocationId] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(invocationId).toBe("wayflow-task-rev-1");
    const v = values as Record<string, unknown>;
    expect(v.reviewSurfaceUrl).toBe("/artifacts/review/run-rev-1/wayflow-task-rev-1");
    expect(v.reviewTaskId).toBe("wayflow-task-rev-1");
    expect(v.targetCount).toBe(2);
    expect(v.agentSummary).toBe("Two items ready for your review.");
    // The legacy reviewer-output envelope must NOT have been synthesized.
    expect(v.contentType).toBeUndefined();
    expect(v.contentBundle).toBeUndefined();

    // Transitions running -> pending_approval like the legacy path.
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1",
      "running",
      "pending_approval",
    );
  });

  it("an UNMARKED reviewer gate is byte-identical: never pins, uses the reviewer-output renderer", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(UNMARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Legacy reviewer summary."),
    });

    expect(gateStoreMock.emitArtifactReviewGate).not.toHaveBeenCalled();
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe("@cinatra-ai/reviewer-agent:output");
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("pin-conflict on a USABLE same-org pending gate routes to it (single decision path)", async () => {
    // A same-run re-emit conflict where a usable pending gate for this run+org
    // exists → route to the review surface (ONE path). Emitting the legacy in-
    // panel gate too would create a second resume path into the same context.
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    gateStoreMock.emitArtifactReviewGate.mockRejectedValueOnce(
      new gateStoreMock.ArtifactReviewGateError("pin-conflict", "different target set"),
    );
    gateStoreMock.readReviewGate.mockResolvedValueOnce({ orgId: "org-rev", status: "pending" });
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1",
      "running",
      "pending_approval",
    );
  });

  it("pin-conflict on a DIFFERENT-org gate falls OPEN to legacy (never redirects to a foreign gate)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    gateStoreMock.emitArtifactReviewGate.mockRejectedValueOnce(
      new gateStoreMock.ArtifactReviewGateError("pin-conflict", "bound to a different org"),
    );
    // The existing gate belongs to ANOTHER org → NOT usable for this run.
    gateStoreMock.readReviewGate.mockResolvedValueOnce({ orgId: "org-OTHER", status: "pending" });
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("a gate re-read FAILURE fails CLOSED — routes to the review surface, never a dual path", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    gateStoreMock.emitArtifactReviewGate.mockRejectedValueOnce(
      new gateStoreMock.ArtifactReviewGateError("pin-conflict", "different target set"),
    );
    // The re-read itself throws (DB blip) → cannot prove the gate absent → must
    // NOT also emit the legacy gate (that would risk a dual path).
    gateStoreMock.readReviewGate.mockRejectedValueOnce(new Error("db blip"));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("invalid-targets (no gate pinned) fails OPEN to the legacy gate (never dead-ends)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    gateStoreMock.emitArtifactReviewGate.mockRejectedValueOnce(
      new gateStoreMock.ArtifactReviewGateError("invalid-targets", "targets must be a non-empty array"),
    );
    gateStoreMock.readReviewGate.mockResolvedValueOnce(null); // no gate exists
    const run = makeRun({ reviewTargets: [] });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    // No gate pinned → fall through to the legacy reviewer gate (single path).
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1",
      "running",
      "pending_approval",
    );
  });

  it("a marked re-emit while already pending_approval does not re-transition (idempotent)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      runId: run.id,
      run,
      fromStatus: "pending_approval",
      task: inputRequiredTask("summary"),
    });

    expect(gateStoreMock.emitArtifactReviewGate).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    // Already pending_approval → the illegal pending->pending transition is skipped.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});
