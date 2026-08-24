/**
 * THE DECLARED REVIEW GOES THROUGH THE CORE (cinatra#2929, epic #2926 W2b).
 *
 * The acceptance's third fixture: a template-marked review step goes through the
 * SAME predicate and the SAME policy as an artifact-bound produced output.
 *
 * WHAT WAS TRUE BEFORE. A marked gate pinned its targets and routed to the
 * review surface unconditionally. The one review kind an agent author states
 * outright was the one kind the policy table had no say over, and an unusable
 * marker was told so by the gate EMITTER rather than by the predicate both kinds
 * share — so the emitter was asked about work that had already failed to name
 * anything at all.
 *
 * WHAT IS TRUE NOW. The core is asked first, through the same boot-bound seam
 * the gate store rides (the run executor imports no database). It answers from
 * the shared binding proof and the shared policy, and only a firing answer
 * reaches the emitter. A declining answer falls through to the ordinary human
 * gate — exactly what an unusable marker has always done — so the single
 * decision path this branch is built around is unchanged: the review surface OR
 * the legacy gate, and never both.
 *
 * The suite drives the seam slot directly, as its sibling does, because that is
 * where the executor reads both the core and the store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
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
type DeclaredDecision =
  | {
      review: true;
      reason: string;
      targets: ReadonlyArray<{ artifactId: string; representationRevisionId: string }>;
    }
  | { review: false; why: string };
const decideSpy = vi.fn<
  (input: {
    orgId: string;
    templateId: string | null;
    packageVersion: string | null;
    targets: unknown;
  }) => Promise<DeclaredDecision>
>(async (input) => ({
  review: true,
  reason: "the review fires by default for durable agent-produced work",
  targets: (input.targets ?? []) as ReadonlyArray<{
    artifactId: string;
    representationRevisionId: string;
  }>,
}));
function bindSeam() {
  (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam = {
    decideDeclaredReview: decideSpy,
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
describe("the declared review asks the one core before it pins anything", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
    storeMock.updateAgentRunA2AContextId.mockResolvedValue(undefined);
    emitSpy.mockResolvedValue({ ok: true });
    readGateSpy.mockResolvedValue(null);
    decideSpy.mockResolvedValue({ review: true, reason: "fires by default", targets: TARGETS });
    bindSeam();
  });
  afterEach(() => unbindSeam());

  it("asks the core with the run's org, its template and the marker's own targets", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Two items ready for your review."),
    });

    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(decideSpy).toHaveBeenCalledWith({
      orgId: "org-rev",
      templateId: "tmpl-rev-1",
      // The run's own pin travels with the question: a template that has moved
      // on must not answer with a skip this run never started under.
      packageVersion: null,
      targets: TARGETS,
    });
    // …and only THEN the gate. The order is the claim: nothing is pinned for
    // work the core has not said a review exists for.
    expect(decideSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      emitSpy.mock.invocationCallOrder[0]!,
    );
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("pins the set the CORE decided for, never the marker's raw value", async () => {
    // A review step can name artifacts the organization's rules disagree about.
    // The core drops the ones a rule forbids, and the gate must pin what it was
    // left with — emitting the raw value again would put a refused artifact back
    // under the gate.
    decideSpy.mockResolvedValue({
      review: true,
      reason: "the review fires for one of the named artifacts",
      targets: [TARGETS[1]!],
    } as never);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(emitSpy).toHaveBeenCalledWith({
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1",
      targets: [TARGETS[1]],
    });
    const [, , values] = onInterruptSpy.mock.calls[0]!;
    expect((values as Record<string, unknown>).targetCount).toBe(1);
  });

  it("a core that could not answer pins the raw value — it must not narrow what a person reviews", async () => {
    decideSpy.mockRejectedValue(new Error("policy store unavailable"));
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ targets: TARGETS }));
  });

  it("a firing decision keeps the surface it always had", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer, values] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect((values as Record<string, unknown>).targetCount).toBe(2);
  });

  it("an organization that FORBIDS this review pins NOTHING and falls through to the ordinary human gate", async () => {
    // The policy reaching the declared kind at all is what this slice adds. The
    // run still stops for a person — a template step that asks is a step that
    // asks — but it stops on its own declared renderer, not on a review surface
    // for a review the organization does not want opened.
    decideSpy.mockResolvedValue({
      review: false,
      why: "org policy forbids review for this class",
    });
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
    expect(xRenderer).toBe("@cinatra-ai/web-research-agent:output");
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("a marker that names nothing usable never reaches the emitter — the predicate answers first", async () => {
    // Before this slice the emitter was handed an unusable target set and
    // answered `invalid-targets`. The binding proof is shared with the produced
    // kind now, so the question is settled before a gate store is asked anything.
    decideSpy.mockResolvedValue({
      review: false,
      why: "the review step names no usable artifact",
    });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: "not-a-target-set" });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe("@cinatra-ai/web-research-agent:output");
  });

  it("a DECLINED review still routes to a gate this run already pinned — never a second decision path", async () => {
    // The fail-closed check the declared kind keeps. A prior execution may have
    // pinned this gate; emitting the legacy gate now would give the same paused
    // context two ways to resume. So a decline re-reads, and a usable pending
    // gate for THIS run and org wins over the legacy gate.
    decideSpy.mockResolvedValue({ review: false, why: "org policy forbids review for this class" });
    readGateSpy.mockResolvedValue({ orgId: "org-rev", status: "pending" });
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

  it("a core that THROWS opens the review the marked step asked for — a decision that cannot be reached decides nothing", async () => {
    decideSpy.mockRejectedValue(new Error("policy store unavailable"));
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("an UNMARKED gate never asks the core at all", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(UNMARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("summary"),
    });

    expect(decideSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
