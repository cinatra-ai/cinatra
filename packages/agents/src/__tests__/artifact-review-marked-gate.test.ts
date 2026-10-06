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
  transitionRunStatus: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
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

// Observe real inventory readings from the actual caller. The implementation
// itself remains real; the spy retains both the input and the exact reading.
const { inventorySpy } = vi.hoisted(() => ({ inventorySpy: vi.fn() }));
vi.mock("@/lib/artifacts/artifact-review-target", async (orig) => {
  const actual = await orig<typeof import("@/lib/artifacts/artifact-review-target")>();
  return { ...actual, inventoryReviewTargets: (value: unknown) => {
    const reading = actual.inventoryReviewTargets(value);
    inventorySpy(value, reading);
    return reading;
  } };
});

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
  (runId: string, reviewTaskId: string) => Promise<{ orgId: string; status: string; targets?: unknown } | null>
>(async () => null);
// cinatra#3035 (epic #3023 W11): the seam also lists the run's own gates, so a
// review that opens one per artifact can route to the first still unread.
const listGatesSpy = vi.fn<
  (runId: string) => Promise<Array<{ reviewTaskId: string; status: string }>>
>(async () => []);
const decideSpy = vi.fn(async (input: { targets: unknown }) => ({ review: true, targets: input.targets, reason: "review the declared work" }));
function bindSeam() {
  (globalThis as { __cinatraArtifactReviewGateSeam?: unknown }).__cinatraArtifactReviewGateSeam = {
    decideDeclaredReview: decideSpy,
    emit: emitSpy,
    readGate: readGateSpy,
    listGates: listGatesSpy,
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
    listGatesSpy.mockResolvedValue([]);
    decideSpy.mockImplementation(async (input: { targets: unknown }) => ({ review: true, targets: input.targets, reason: "review the declared work" }));
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
    // cinatra#3035 (epic #3023 W11) — ONE REVIEW PER ARTIFACT. A two-artifact
    // set is two reviews, one gate each, in the order the set named them; the
    // person is routed to the first. It used to be one gate over both.
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenNthCalledWith(1, {
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1",
      targets: [TARGETS[0]],
    });
    expect(emitSpy).toHaveBeenNthCalledWith(2, {
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1#2",
      targets: [TARGETS[1]],
    });

    // (2) Routed via the redirect renderer id — NOT the legacy reviewer envelope.
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer, values, invocationId] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(invocationId).toBe("wayflow-task-rev-1");
    const v = values as Record<string, unknown>;
    // Owner ruling 2026-07-25 (3): the review reads UNDER the agent run — and
    // since cinatra#3693 it reads IN it, with no page of its own. The template
    // packageName (@cinatra-ai/web-research-agent) gives the run base
    // /agents/cinatra-ai/web-research-agent/run-rev-1, and the gate travels as
    // the run detail's own rail selection rather than as a sub-path.
    expect(v.reviewSurfaceUrl).toBe(
      "/agents/cinatra-ai/web-research-agent/run-rev-1?step=review%3Awayflow-task-rev-1",
    );
    expect(v.reviewSurfaceUrl).not.toContain("/review/");
    expect(v.reviewTaskId).toBe("wayflow-task-rev-1");
    // cinatra#3035 (epic #3023 W11): the surface a person lands on shows ONE
    // artifact — the first of the two the set named.
    expect(v.targetCount).toBe(1);
    expect(v.agentSummary).toBe("Two items ready for your review.");
    // cinatra#1796: the host synthesizes no review envelope at all any more —
    // the synthesis was deleted with the reviewer rendering teardown. These stay
    // asserted so a re-introduction is caught here too.
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

  it("an UNMARKED gate is byte-identical: never pins, keeps its own declared renderer", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(UNMARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask("Legacy gate summary."),
    });

    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe("@cinatra-ai/web-research-agent:output");
    expect(xRenderer).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("App163: an unbound seam cannot read policy or authorize a new decision path", async () => {
    unbindSeam();
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await expect(handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("summary") })).rejects.toThrow();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
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

    // cinatra#3035 (epic #3023 W11) — ONE REVIEW PER ARTIFACT. A two-artifact
    // set is two reviews, one gate each, in the order the set named them; the
    // person is routed to the first. It used to be one gate over both.
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("pins the target set the gate's own surfaced message carries, which is the only road on the pinned runtime (cinatra#3035)", async () => {
    // The pinned runtime never writes task.metadata on an interrupt: a flagged
    // gate hands its inputs over only as its own message, a JSON object whose
    // marked value is itself a JSON string. The run's start default (an empty
    // set) must not shadow it.
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: [] });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: run.id,
      run,
      fromStatus: "running",
      task: inputRequiredTask(JSON.stringify({ reviewTargets: JSON.stringify([TARGETS[0]]) })),
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({
      runId: "run-rev-1",
      orgId: "org-rev",
      reviewTaskId: "wayflow-task-rev-1",
      targets: [TARGETS[0]],
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    const [, xRenderer] = onInterruptSpy.mock.calls[0]!;
    expect(xRenderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it.each(["pending", "resolved"] as const)("grandfathered %s combined pause replays as minted without scalar siblings", async (status) => {
    const originalId = "wayflow-task-rev-1";
    const original = { orgId: "org-rev", status, targets: [...TARGETS], disposition: status === "resolved" ? "reject" : null, fingerprint: "original-fingerprint" };
    const before = JSON.stringify(original);
    const rows = new Map([[originalId, original]]);
    readGateSpy.mockImplementation(async (_runId, id) => rows.get(id) ?? null);
    listGatesSpy.mockImplementation(async () => [...rows.entries()].map(([reviewTaskId, row]) => ({ reviewTaskId, status: row.status })));
    emitSpy.mockImplementation(async (input) => {
      const existing = rows.get(input.reviewTaskId);
      if (existing) {
        return JSON.stringify(input.targets) === JSON.stringify(existing.targets) && input.orgId === existing.orgId
          ? { ok: true }
          : { ok: false, code: "pin-conflict", message: "the original pins are immutable" };
      }
      const targets = input.targets as typeof TARGETS;
      if (targets.length !== 1) return { ok: false, code: "invalid-targets", message: "new gates must be singleton" };
      rows.set(input.reviewTaskId, { orgId: input.orgId, status: "pending", targets, disposition: null, fingerprint: "new" });
      return { ok: true };
    });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("original combined review") });
    expect([...rows.keys()]).toEqual([originalId]);
    expect(JSON.stringify(rows.get(originalId))).toBe(before);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ runId: run.id, orgId: run.orgId, reviewTaskId: originalId, targets: TARGETS });
    const [, renderer, values, routedId] = onInterruptSpy.mock.calls[0]!;
    expect(renderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(routedId).toBe(originalId);
    expect((values as Record<string, unknown>).targetCount).toBe(2);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  for (const fromStatus of ["running", "pending_approval"] as const) {
    it.each(["missing", "foreign", "resolved", "unreadable", "list-unreadable"] as const)(
      `a failed inventory or later %s refusal cannot authorize a second decision (${fromStatus})`,
      async (recovery) => {
        const originalId = "wayflow-task-rev-1";
        const rows = new Map<string, { orgId: string; status: string; targets: typeof TARGETS }>();
        emitSpy.mockImplementation(async (input) => {
          if (input.reviewTaskId === originalId) {
            rows.set(originalId, { orgId: input.orgId, status: "pending", targets: input.targets as typeof TARGETS });
            return { ok: true };
          }
          return { ok: false, code: "invalid-targets", message: "later artifact could not be pinned" };
        });
        readGateSpy.mockImplementation(async (_runId, id) => {
          if (id === originalId) return rows.get(id) ?? null;
          if (recovery === "unreadable") throw new Error("later gate unreadable");
          if (recovery === "foreign") return { orgId: "org-OTHER", status: "pending", targets: [TARGETS[1]] };
          if (recovery === "resolved") return { orgId: "org-rev", status: "resolved", targets: [TARGETS[1]] };
          return null;
        });
        listGatesSpy.mockImplementation(async () => {
          if (recovery === "list-unreadable") throw new Error("gate list unavailable");
          return [...rows.entries()].map(([reviewTaskId, row]) => ({ reviewTaskId, status: row.status }));
        });
        storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
        const run = makeRun({ reviewTargets: TARGETS });
        const attempt = handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus, task: inputRequiredTask("partial review mint") });
        if (recovery === "list-unreadable") {
          // App160 supersedes the old post-mint fallback: the initial read
          // refuses before any gate or second decision can be created.
          await expect(attempt).rejects.toThrow("gate list unavailable");
          expect(emitSpy).not.toHaveBeenCalled();
          expect([...rows.keys()]).toEqual([]);
          expect(onInterruptSpy).not.toHaveBeenCalled();
          expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
          return;
        }
        await attempt;
        expect(listGatesSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledTimes(2);
        expect([...rows.keys()]).toEqual([originalId]);
        expect(rows.get(originalId)?.status).toBe("pending");
        expect(onInterruptSpy).toHaveBeenCalledTimes(1);
        const [, renderer, values, routedId] = onInterruptSpy.mock.calls[0]!;
        expect(renderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
        expect(routedId).toBe(originalId);
        expect((values as Record<string, unknown>).targetCount).toBe(1);
        expect((values as Record<string, unknown>).reviewSurfaceUrl).toContain("step=review%3Awayflow-task-rev-1");
      },
    );
  }

  it("a combined gate appearing after the preflight read cannot acquire a scalar sibling", async () => {
    const originalId = "wayflow-task-rev-1";
    const original = { orgId: "org-rev", status: "pending", targets: [...TARGETS], disposition: null, fingerprint: "race-original" };
    const before = JSON.stringify(original);
    const rows = new Map<string, typeof original>();
    readGateSpy.mockImplementation(async (_runId, id) => rows.get(id) ?? null);
    listGatesSpy.mockImplementation(async () => [...rows.entries()].map(([reviewTaskId, row]) => ({ reviewTaskId, status: row.status })));
    emitSpy.mockImplementation(async (input) => {
      if (input.reviewTaskId === originalId) {
        // Another execution minted the historical gate after the null preflight.
        rows.set(originalId, original);
        return { ok: false, code: "pin-conflict", message: "the existing complete pins differ" };
      }
      rows.set(input.reviewTaskId, { orgId: input.orgId, status: "pending", targets: input.targets as typeof TARGETS, disposition: null, fingerprint: "new" });
      return { ok: true };
    });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("preflight race") });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect([...rows.keys()]).toEqual([originalId]);
    expect(JSON.stringify(rows.get(originalId))).toBe(before);
    const [, renderer, values, routedId] = onInterruptSpy.mock.calls[0]!;
    expect(renderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(routedId).toBe(originalId);
    expect((values as Record<string, unknown>).targetCount).toBe(2);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a mismatched caller set cannot fork or replace an original combined review", async () => {
    const originalId = "wayflow-task-rev-1";
    const originalTargets = [...TARGETS, { artifactId: "art-original-3", representationRevisionId: "rev-original-3" }];
    const original = { orgId: "org-rev", status: "pending", targets: originalTargets };
    readGateSpy.mockResolvedValue(original);
    emitSpy.mockResolvedValue({ ok: false, code: "pin-conflict", message: "the complete original set differs" });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("mismatched caller") });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ runId: run.id, orgId: run.orgId, reviewTaskId: originalId, targets: TARGETS });
    expect(original.targets).toEqual(originalTargets);
    const [, renderer, values, routedId] = onInterruptSpy.mock.calls[0]!;
    expect(renderer).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect(routedId).toBe(originalId);
    expect((values as Record<string, unknown>).targetCount).toBe(3);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a foreign original combined gate creates no scalar sibling and never redirects to that gate", async () => {
    readGateSpy.mockResolvedValue({ orgId: "org-OTHER", status: "pending", targets: TARGETS });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: inputRequiredTask("foreign original") });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy.mock.calls[0]![1]).not.toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("an unreadable original-gate lookup cannot authorize scalar siblings", async () => {
    readGateSpy.mockRejectedValue(new Error("original gate read unavailable"));
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: inputRequiredTask("unavailable original") });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy.mock.calls[0]![1]).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
  });

  it("a prior gate without readable pins cannot authorize a new sibling", async () => {
    readGateSpy.mockResolvedValue({ orgId: "org-rev", status: "pending" });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: inputRequiredTask("unreadable original pins") });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy.mock.calls[0]![1]).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
    expect((onInterruptSpy.mock.calls[0]![2] as Record<string, unknown>).targetCount).toBeNull();
  });

  it.each(["running", "pending_approval"] as const)("App160: an unavailable gate list blocks mint and new interrupt from %s", async (status) => {
    const failure = new Error("existing gate list unavailable");
    listGatesSpy.mockRejectedValue(failure);
    const original = { orgId: "org-rev", status: "pending", targets: [...TARGETS], fingerprint: "immutable-before-read-failure" };
    const before = JSON.stringify(original);
    readGateSpy.mockResolvedValue(original);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    await expect(handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: status, task: inputRequiredTask("existing marked review") })).rejects.toBe(failure);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each(["running", "pending_approval"] as const)("App161: a differing revision cannot reuse the first leg or proceed from %s", async (fromStatus) => {
    const originalId = "wayflow-task-rev-1";
    const original = { orgId: "org-rev", status: "pending", targets: [TARGETS[0]], fingerprint: "immutable-v1" };
    const before = JSON.stringify(original);
    const newer = { artifactId: TARGETS[0].artifactId, representationRevisionId: "rev-NEW" };
    const request = [TARGETS[0], newer, TARGETS[1]];
    readGateSpy.mockResolvedValue(original);
    listGatesSpy.mockResolvedValue([{ reviewTaskId: originalId, status: "pending" }]);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: request });
    const dispatch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No newer-revision action may dispatch from a held step"));
    try {
      await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus, task: inputRequiredTask("revision mismatch") });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(original)).toBe(before);
      expect(run.inputParams?.reviewTargets).toEqual(request);
      expect(onInterruptSpy).toHaveBeenCalledTimes(1);
      expect(onInterruptSpy.mock.calls[0]?.[1]).toBe(ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
      expect(onInterruptSpy.mock.calls[0]?.[3]).toBe(originalId);
      expect((onInterruptSpy.mock.calls[0]?.[2] as Record<string, unknown>).targetCount).toBe(1);
      if (fromStatus === "running") expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(run.id, "running", "pending_approval", undefined, TEST_AUTHORITY);
      else expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus.mock.calls.every((call) => call[2] !== "running" && call[2] !== "completed")).toBe(true);
    } finally { dispatch.mockRestore(); }
  });

  it.each([null, { artifactId: "unknown" }, "unknown-pin"])("App160: malformed caller pins %j cannot mint a valid subset beside an existing gate", async (invalid) => {
    const original = { orgId: "org-rev", status: "pending", targets: [TARGETS[0]], fingerprint: "preserved-v1" };
    const before = JSON.stringify(original);
    readGateSpy.mockResolvedValue(original);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: [TARGETS[0], invalid, invalid, TARGETS[1]] });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("unknown pins") });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(before);
    expect(onInterruptSpy.mock.calls[0]?.[3]).toBe("wayflow-task-rev-1");
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it.each(["only-ambiguous", "other-after", "other-before"])("App162: without an original, %s refuses the whole ambiguous set and parks before any action", async (variation) => {
    const newer = { artifactId: TARGETS[0].artifactId, representationRevisionId: "rev-NEW" };
    const request = variation === "only-ambiguous" ? [TARGETS[0], newer] : variation === "other-after" ? [TARGETS[0], newer, TARGETS[1]] : [TARGETS[1], TARGETS[0], newer];
    const before = JSON.stringify(request);
    readGateSpy.mockResolvedValue(null);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: request });
    // Test a core-approved set as well as the existing resolver-fault controls:
    // the executor must not turn two distinct revisions into two artifact gates.
    const seam = (globalThis as { __cinatraArtifactReviewGateSeam?: Record<string, unknown> }).__cinatraArtifactReviewGateSeam!;
    seam.decideDeclaredReview = vi.fn(async () => ({ review: true, reason: "review this declared work", targets: request }));
    const dispatch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No ambiguous artifact action may dispatch from a held step"));
    try {
      await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: inputRequiredTask("ambiguous revisions") });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(request)).toBe(before);
      expect(onInterruptSpy).toHaveBeenCalledTimes(1);
      expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(run.id, "running", "pending_approval", undefined, TEST_AUTHORITY);
      expect(storeMock.transitionRunStatus.mock.calls.every((call) => call[2] !== "running" && call[2] !== "completed")).toBe(true);
    } finally { dispatch.mockRestore(); }
  });

  it.each(["exclude-A", "keep-one-A", "keep-two-A"])("App163: %s retains raw inventory and respects the successful policy result", async (policy) => {
    const newer = { artifactId: TARGETS[0].artifactId, representationRevisionId: "rev-NEW" };
    const raw = [TARGETS[0], newer, TARGETS[1]];
    const before = JSON.stringify(raw);
    const kept = policy === "exclude-A" ? [TARGETS[1]] : policy === "keep-one-A" ? [TARGETS[0], TARGETS[1]] : [TARGETS[0], newer];
    decideSpy.mockResolvedValue({ review: true, targets: kept, reason: "approved existing policy result" });
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: raw });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: inputRequiredTask("policy filtered review") });
    expect(inventorySpy.mock.calls[0]?.[0]).toBe(raw);
    expect(inventorySpy.mock.calls[0]?.[1]).toMatchObject({ rawTargetCount: 3, distinctValidPairCount: 3, validOccurrenceCount: 3, invalidOccurrenceCount: 0, validPairs: raw });
    expect(inventorySpy.mock.calls.some(([value]) => value === kept)).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
    if (policy === "keep-two-A") expect(emitSpy).not.toHaveBeenCalled();
    else {
      expect(emitSpy).toHaveBeenCalledTimes(kept.length);
      expect(emitSpy.mock.calls.map(([input]) => input.targets)).toEqual(kept.map((target) => [target]));
      expect(emitSpy.mock.calls.flatMap(([input]) => input.targets as typeof raw)).not.toContainEqual(newer);
    }
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(run.id, "running", "pending_approval", undefined, TEST_AUTHORITY);
  });

  it.each(["throws", "missing"])("App163: a policy core that %s cannot authorize mint or action", async (mode) => {
    const failure = new Error("policy core unavailable");
    if (mode === "throws") decideSpy.mockRejectedValue(failure);
    else delete (globalThis as { __cinatraArtifactReviewGateSeam?: Record<string, unknown> }).__cinatraArtifactReviewGateSeam!.decideDeclaredReview;
    const original = { orgId: "org-rev", status: "pending", targets: [TARGETS[0]], fingerprint: "immutable-before-core-fault" };
    const before = JSON.stringify(original);
    readGateSpy.mockResolvedValue(original);
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(MARKED_STEP));
    const run = makeRun({ reviewTargets: TARGETS });
    const dispatch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No action may dispatch after a policy fault"));
    try {
      const result = handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "pending_approval", task: inputRequiredTask("policy fault") });
      if (mode === "throws") await expect(result).rejects.toBe(failure);
      else await expect(result).rejects.toThrow();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(onInterruptSpy).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      expect(JSON.stringify(original)).toBe(before);
    } finally { dispatch.mockRestore(); }
  });

});
