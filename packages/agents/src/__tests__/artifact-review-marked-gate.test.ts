import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// cinatra#1796 (epic #1620 S13) — the execution.ts MARKED artifact-review gate.
//
// When an input-required gate carries the compiled `artifactReviewTargetsInput`
// marker, handleWayflowTaskState must (1) PIN the run's immutable review targets
// via the boot-bound gate SEAM (globalThis.__cinatraArtifactReviewGateSeam) and
// (2) route the human to the generic review surface (the redirect renderer id +
// reviewSurfaceUrl) INSTEAD of the legacy reviewer envelope. An UNMARKED gate
// must behave byte-identically. execution.ts reads the seam off globalThis (it
// never imports the store — a route-graph-ratchet constraint), so this suite
// drives the seam slot directly.

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
// cinatra#1939 wave 2: handleWayflowTaskState now requires an org-write authority.
// transitionRunStatus is mocked here (../store is a full mock), so an inert
// member-shaped authority satisfies the type without affecting behavior.
const TEST_AUTHORITY = { orgId: "org-1", can: () => true };
import type { AgentRunRecord } from "../store";

// The boot-bound gate seam execution.ts reads off globalThis. Spied per test.
type EmitResult =
  | { ok: true }
  | { ok: false; code: "invalid-targets" | "pin-conflict"; message: string };
const emitSpy = vi.fn<
  (input: {
    runId: string;
    orgId: string;
    reviewTaskId: string;
    targets: unknown;
  }) => Promise<EmitResult>
>(async () => ({ ok: true }));
const readGateSpy = vi.fn<
  (runId: string, reviewTaskId: string) => Promise<{ orgId: string; status: string } | null>
>(async () => null);
function bindSeam() {
  (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam = {
    emit: emitSpy,
    readGate: readGateSpy,
  };
}
function unbindSeam() {
  delete (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam;
}

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
    packageName: "@cinatra-ai/web-research-agent",
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
  xRenderer: "@cinatra-ai/web-research-agent:output",
  artifactReviewTargetsInput: "reviewTargets",
};
const UNMARKED_STEP = {
  stepNumber: 1,
  nodeType: "input_message",
  requiresApproval: true,
  hitlOwnedBy: "self",
  xRenderer: "@cinatra-ai/web-research-agent:output",
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

describe("execution.ts — marked artifact-review gate (pin + route via the boot seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
    emitSpy.mockResolvedValue({ ok: true });
    readGateSpy.mockResolvedValue(null);
    bindSeam();
  });
  afterEach(() => unbindSeam());

  it("pins the flow-input targets + routes to the generic review surface", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Two items ready for your review."),
    });

    // (1) Pinned with the run's immutable targets under the wayflow reviewTaskId.
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1",
      targets: TARGETS,
    });

    // (2) Routed via the redirect renderer id — NOT the legacy reviewer envelope.
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer, values, invocationId] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(invocationId).toBe("wayflow-task-rev-1");
    const v = values as Record<string, unknown>;
    // Owner ruling 2026-07-25 (3): the review surface lives UNDER the agent run.
    // The template packageName (@cinatra-ai/web-research-agent) → the run base
    // /agents/cinatra-ai/reviewer-agent/run-rev-1, then the review sub-path.
    expect(v.reviewSurfaceUrl).toBe(
      "/agents/cinatra-ai/reviewer-agent/run-rev-1/review/wayflow-task-rev-1",
    );
    expect(v.reviewTaskId).toBe("wayflow-task-rev-1");
    expect(v.targetCount).toBe(2);
    expect(v.agentSummary).toBe("Two items ready for your review.");
    // The legacy reviewer-output envelope must NOT have been synthesized.
    expect(v.contentType).toBeUndefined();
    expect(v.contentBundle).toBeUndefined();

    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1",
      "running",
      "pending_approval",
      undefined,
      TEST_AUTHORITY,
    );
  });

  it("an UNMARKED reviewer gate is byte-identical: never pins, uses the reviewer-output renderer", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(UNMARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Legacy reviewer summary."),
    });

    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe("@cinatra-ai/web-research-agent:output");
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("unbound seam fails CLOSED — routes to the review surface, never a dual path", async () => {
    // Boot has not bound the seam (a near-impossible degraded state). We cannot
    // pin nor read the gate, so we must NOT also emit the legacy gate (a prior
    // execution may already have pinned this gate → dual path). Route to the
    // review surface instead (fail-closed).
    unbindSeam();
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("pin-conflict on a USABLE same-org pending gate routes to it (single decision path)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    emitSpy.mockResolvedValue({ ok: false, code: "pin-conflict", message: "different target set" });
    readGateSpy.mockResolvedValue({ orgId: "org-rev", status: "pending" });
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
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
      undefined,
      TEST_AUTHORITY,
    );
  });

  it("pin-conflict on a DIFFERENT-org gate falls OPEN to legacy (never redirects to a foreign gate)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    emitSpy.mockResolvedValue({ ok: false, code: "pin-conflict", message: "bound to a different org" });
    readGateSpy.mockResolvedValue({ orgId: "org-OTHER", status: "pending" });
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
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
    emitSpy.mockResolvedValue({ ok: false, code: "pin-conflict", message: "different target set" });
    readGateSpy.mockRejectedValue(new Error("db blip"));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
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
    emitSpy.mockResolvedValue({
      ok: false,
      code: "invalid-targets",
      message: "targets must be a non-empty array",
    });
    readGateSpy.mockResolvedValue(null); // no gate exists
    const run = makeRun({ reviewTargets: [] });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1",
      "running",
      "pending_approval",
      undefined,
      TEST_AUTHORITY,
    );
  });

  it("a marked re-emit while already pending_approval does not re-transition (idempotent)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "pending_approval",
      task: inputRequiredTask("summary"),
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});
