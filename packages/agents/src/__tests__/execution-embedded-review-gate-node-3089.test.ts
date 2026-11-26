import { planPerArtifactReviewGates } from "@/lib/artifacts/artifact-review-target";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// cinatra#3089 — the marker of an EMBEDDED review gate is applied by the pause's
// verified node, never by its position. Harness from
// artifact-review-marked-gate.test.ts (cinatra#1796).
//
// Original harness note: the execution.ts MARKED artifact-review gate.
//
// When an input-required gate carries the compiled `artifactReviewTargetsInput`
// marker, handleWayflowTaskState must (1) PIN the run's immutable review targets
// via the boot-bound gate SEAM (globalThis.__cinatraArtifactReviewGateSeam) and
// (2) route the human to the generic review surface (the redirect renderer id +
// reviewSurfaceUrl) INSTEAD of the legacy reviewer envelope. An UNMARKED gate
// must behave byte-identically. execution.ts reads the seam off globalThis (it
// never imports the store — a route-graph-ratchet constraint), so this suite
// drives the seam slot directly.

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID, SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { GATE_KEYS_NOT_FROM_RUN_INPUTS } from "../gate-keys-not-from-run-inputs";
import { PAUSE_POLICY_READ_WAITS_MS } from "../orchestrator-gate-predicate";

const { enrichSpy, onInterruptSpy, gateIndexSpy, publishSpy } = vi.hoisted(() => {
  const enrichSpy = vi.fn(async (schema: unknown) => ({ ...(schema as object) }));
  const onInterruptSpy = vi.fn();
  const gateIndexSpy = vi.fn(async () => 0);
  const publishSpy = vi.fn(async (..._args: unknown[]) => undefined);
  return { enrichSpy, onInterruptSpy, gateIndexSpy, publishSpy };
});

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishSpy,
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
  // cinatra#3089: a pause reads the steps its dispatch compiled from the mounted source; none until the test binds them.
  readRunPauseSteps: vi.fn(async (): Promise<unknown> => { throw new Error("no pause steps were compiled from the source bound to the run"); }),
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
// cinatra#3089: the steps the dispatch compiled from the mounted source and bound with it: here the template's policy as
// it was when the test bound it (a copy), never a later template read; with no policy, none compiled (the reader refuses).
function bindTemplate(t: unknown): void {
  storeMock.readAgentTemplateById.mockResolvedValue(t as never);
  const read = t as { approvalPolicy?: unknown } | null | undefined;
  if (read?.approvalPolicy === undefined || read.approvalPolicy === null) storeMock.readRunPauseSteps.mockRejectedValue(new Error("no pause steps were compiled from the source bound to the run"));
  else storeMock.readRunPauseSteps.mockResolvedValue({ approvalPolicy: structuredClone(read.approvalPolicy) });
}
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
// The produced-output review question every failure edge asks first, and the claimed resume leg's bind.
const holdMock = vi.hoisted(() => ({ holdRunForProducedReview: vi.fn(async (): Promise<{ held: boolean; reason: string }> => ({ held: false, reason: "no-produced-output" })) }));
vi.mock("../run-produced-review-hold", () => holdMock);
vi.mock("../run-transition", async (orig) => ({ ...(await orig<Record<string, unknown>>()), bindResumeLegToTask: vi.fn(async () => true) }));
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
    rememberWayflowGateNodeClaim: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: gateIndexSpy,
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
    emitFamily: async (input: { runId: string; orgId: string; reviewTaskId: string; targets: unknown }) => {
      for (const leg of planPerArtifactReviewGates(input)) {
        const result = await emitSpy({ ...input, reviewTaskId: leg.reviewTaskId, targets: leg.targets });
        if (!result.ok) return result;
      }
      return { ok: true };
    },
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

function makeTemplate(steps: Array<Record<string, unknown>>, packageVersion: string | null = null) {
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
    packageVersion,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: { steps },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

// The outreach shape as compiled: a recipients review, the embedded drafts
// review (marked, naming its gate's node), and a send confirmation after it.
const RECIPIENTS_STEP = {
  stepNumber: 1, nodeType: "agent", requiresApproval: true, hitlOwnedBy: "self", gateCount: 1, xRenderer: "@test/recipients:review",
  inputMessageSchema: { type: "object", properties: { recipientsNote: { type: "string" } } }, surfaceGateInputKeys: ["confirmedRecipients"],
};
const DRAFTS_STEP = {
  stepNumber: 2, nodeType: "agent", requiresApproval: true, hitlOwnedBy: "self", gateCount: 1,
  xRenderer: "@test/drafting:review",
  inputMessageSchema: { type: "object", properties: { userResponse: { type: "string" } } }, surfaceGateInputKeys: ["reviewTargets"],
  artifactReviewTargetsInput: "reviewTargets",
  artifactReviewGateNode: "drafts-approval_gate",
};
const SEND_STEP = {
  stepNumber: 3, nodeType: "agent", requiresApproval: true, hitlOwnedBy: "self", gateCount: 1, xRenderer: "@test/delivery:send-confirmation",
  inputMessageSchema: { type: "object", properties: { confirmSend: { type: "string" } } }, surfaceGateInputKeys: ["campaignId"],
};
// What the pause itself carries (its pendingApproval), drawn when no step is.
const OWN_SCHEMA = { type: "object", properties: { ownField: { type: "string" } } };
const RUN_INPUTS = { reviewTargets: [{ artifactId: "art-1", representationRevisionId: "rev-1" }], campaignId: "camp-1", confirmedRecipients: "r1" };
const OUTREACH = [RECIPIENTS_STEP, DRAFTS_STEP, SEND_STEP];
const KEY = "test-gate-node-key-3089";
const TARGETS = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];

function signedClaim(node: string, key = KEY, ctx = "ctx-rev-1", taskId = "task-rev-1") {
  const sig = createHmac("sha256", key).update(`g1\n${ctx}\n${taskId}\n${node}`).digest("hex");
  return { node, attestation: `g1:${sig}` };
}
function pausedTask(claim: unknown) {
  return {
    id: "task-rev-1",
    contextId: "ctx-rev-1",
    status: { state: "input-required", message: { parts: [] } },
    metadata: { pendingApproval: OWN_SCHEMA },
    history: [{ role: "agent", parts: [{ kind: "text", text: "Ready." }], ...(claim ? { metadata: { cinatra_gate_node: claim } } : {}) }],
  };
}
async function pause(claim: unknown, gateIndex: number, steps: Array<Record<string, unknown>> = OUTREACH) {
  bindTemplate(makeTemplate(steps));
  gateIndexSpy.mockResolvedValue(gateIndex);
  const run = makeRun({ ...RUN_INPUTS, reviewTargets: TARGETS });
  await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(claim) });
}
const routedToReview = () => onInterruptSpy.mock.calls.some((c) => c[1] === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID);
// The one ordinary gate drawn: its schema, renderer and values.
function drawn() {
  expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  const [schema, xRenderer, values] = onInterruptSpy.mock.calls[0]! as [Record<string, unknown>, string, Record<string, unknown>];
  return { schema, xRenderer, values, props: Object.keys((schema.properties ?? {}) as object) };
}
const stoppedWith = (code: string) =>
  expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
    "run-rev-1", "running", "failed", expect.objectContaining({ error: expect.stringMatching(new RegExp(`^${code}: `)) }), TEST_AUTHORITY,
  );

describe("cinatra#3089 — an embedded review gate's marker follows the verified node that paused", () => {
  const savedKey = process.env.CINATRA_CONTEXT_ATTEST_KEY;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CINATRA_CONTEXT_ATTEST_KEY = KEY;
    enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
    emitSpy.mockResolvedValue({ ok: true });
    readGateSpy.mockResolvedValue(null);
    listGatesSpy.mockResolvedValue([]);
    decideSpy.mockImplementation(async (input: { targets: unknown }) => ({ review: true, targets: input.targets, reason: "review the declared work" }));
    // No steps are bound until the test binds them (bindTemplate, or the pinned cases below).
    storeMock.readRunPauseSteps.mockReset();
    bindSeam();
  });
  afterEach(() => {
    unbindSeam();
    if (savedKey === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    else process.env.CINATRA_CONTEXT_ATTEST_KEY = savedKey;
  });

  it("the marked gate paused first (a parent branch skipped the earlier review): its marker applies, not the first step's", async () => {
    await pause(signedClaim("drafts-approval_gate"), 0);
    // red-first-expect: expected "vi.fn()" to be called at least once
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("another gate paused in the marked step's place (a branch around the FlowNode): the marker does not apply", async () => {
    await pause(signedClaim("sender-approval_gate"), 1);
    // red-first-expect: expected "vi.fn()" to not be called at all
    expect(emitSpy).not.toHaveBeenCalled();
    expect(routedToReview()).toBe(false);
  });

  it("the marked gate paused in its own place: its marker applies", async () => {
    await pause(signedClaim("drafts-approval_gate"), 1);
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("without a verified node the pause is no approval: the run is stopped failed with a fixed text", async () => {
    for (const [label, claim] of [
      ["no claim", null],
      ["a claim signed with another key", signedClaim("drafts-approval_gate", "other-key")],
    ] as const) {
      vi.clearAllMocks();
      await pause(claim, 1);
      expect(emitSpy, label).not.toHaveBeenCalled();
      expect(onInterruptSpy, label).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus, label).toHaveBeenCalledWith(
        "run-rev-1", "running", "failed",
        expect.objectContaining({ error: expect.stringMatching(/^ARTIFACT_REVIEW_GATE_UNVERIFIED: /) }),
        TEST_AUTHORITY,
      );
      expect(storeMock.transitionRunStatus, label).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "pending_approval", expect.anything(), expect.anything(),
      );
    }
    vi.clearAllMocks();
    delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
    await pause(signedClaim("drafts-approval_gate"), 1);
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1", "running", "failed", expect.objectContaining({ error: expect.stringMatching(/^ARTIFACT_REVIEW_GATE_UNVERIFIED: /) }), TEST_AUTHORITY,
    );
  });

  it("a template whose marked step names no node keeps today's reading, claim or not", async () => {
    const legacy = [RECIPIENTS_STEP, { ...DRAFTS_STEP, artifactReviewGateNode: undefined }, SEND_STEP];
    await pause(null, 1, legacy);
    expect(emitSpy).toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", expect.anything(), expect.anything());
  });

  it("a verified node the position did not pick takes ALL of its step: renderer, schema, step number and keys", async () => {
    // The review core declines this work, so the step is drawn as an ordinary gate.
    decideSpy.mockImplementation(async () => ({ review: false, why: "declined" }) as never);
    await pause(signedClaim("drafts-approval_gate"), 0);
    const g = drawn();
    // red-first-expect: expected '@test/recipients:review' to be '@test/drafting:review'
    expect(g.xRenderer).toBe("@test/drafting:review");
    expect(g.values.stepNumber).toBe(2);
    expect(g.props).toContain("userResponse");
    expect(g.props).not.toContain("recipientsNote");
    expect(g.schema[GATE_KEYS_NOT_FROM_RUN_INPUTS]).toEqual(["reviewTargets"]);
    expect(g.values.confirmedRecipients).toBe("r1");
  });

  it("a position that picked the node-named step of another node draws nothing of it: the pause's own schema in the plain form", async () => {
    await pause(signedClaim("sender-approval_gate"), 1);
    const g = drawn();
    expect(g.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(g.values.stepNumber).toBeUndefined();
    expect(g.props).toEqual(["ownField"]);
    // No step is pinned: every key any step lists is withheld from the run's inputs.
    for (const k of ["reviewTargets", "campaignId", "confirmedRecipients"]) expect(g.values[k], k).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("a read of the bound steps that throws is retried in the handler: the read that works decides the pause by its node as usual", async () => {
    // The claim verifies, so the publish classification reads nothing; the
    // pause's first read of the steps bound at the dispatch fails, its retry succeeds.
    bindTemplate(makeTemplate(OUTREACH));
    storeMock.readRunPauseSteps.mockRejectedValueOnce(new Error("store blip"));
    gateIndexSpy.mockResolvedValue(0);
    const run = makeRun({ ...RUN_INPUTS, reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(run.id, "running", "failed", expect.anything(), expect.anything());
    // red-first-expect: expected "vi.fn()" to be called at least once
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("a read of the bound steps that throws in every attempt stops the run after the bounded retries: nothing is offered", async () => {
    bindTemplate(makeTemplate(OUTREACH));
    storeMock.readRunPauseSteps.mockRejectedValue(new Error("store down"));
    gateIndexSpy.mockResolvedValue(1);
    const run = makeRun({ ...RUN_INPUTS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("PAUSE_POLICY_UNREAD");
    // The pause's first read and its retries (the verified claim needs no publish read).
    expect(storeMock.readRunPauseSteps).toHaveBeenCalledTimes(1 + PAUSE_POLICY_READ_WAITS_MS.length);
  });

  // The steps the dispatch compiled from the source the loader mounted (`mounted`) and the template row at the pause
  // (`row`), which an install rewrites before the loader reloads, or when the reload fails.
  const UNMARKED_DRAFTS = { ...DRAFTS_STEP } as Record<string, unknown>;
  delete UNMARKED_DRAFTS.artifactReviewTargetsInput;
  delete UNMARKED_DRAFTS.artifactReviewGateNode;
  const UNMARKED = [RECIPIENTS_STEP, UNMARKED_DRAFTS, SEND_STEP];
  async function pauseBound(mounted: Array<Record<string, unknown>> | null | "none", row: Array<Record<string, unknown>> | Error) {
    storeMock.readAgentTemplateById.mockReset();
    if (row instanceof Error) storeMock.readAgentTemplateById.mockRejectedValue(row);
    else storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(row) as never);
    storeMock.readRunPauseSteps.mockReset();
    // "none": a binding written before steps were bound (the reader answers null); null: a binding that records no steps.
    if (mounted === "none") storeMock.readRunPauseSteps.mockResolvedValue(null);
    else if (mounted === null) storeMock.readRunPauseSteps.mockRejectedValue(new Error("no pause steps were compiled from the source bound to the run"));
    else storeMock.readRunPauseSteps.mockResolvedValue({ approvalPolicy: { steps: structuredClone(mounted) } });
    gateIndexSpy.mockResolvedValue(1);
    const run = makeRun({ ...RUN_INPUTS, reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
  }

  it("the row shows version 2 with the marker removed, the mounted version 1 has it: the per-artifact review is kept", async () => {
    await pauseBound(OUTREACH, UNMARKED);
    // red-first-expect: expected "vi.fn()" to be called at least once
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("the row shows version 1 with the marker, the mounted version 2 has none: the pause is the ordinary approval of version 2", async () => {
    await pauseBound(UNMARKED, OUTREACH);
    // red-first-expect: expected "vi.fn()" to not be called at all
    expect(emitSpy).not.toHaveBeenCalled();
    expect(routedToReview()).toBe(false);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith("run-rev-1", "running", "failed", expect.anything(), expect.anything());
  });

  it("a failed reload keeps the mounted version 1 running after the row moved on: its bound steps classify every pause", async () => {
    for (let i = 0; i < 2; i += 1) {
      vi.clearAllMocks();
      await pauseBound(OUTREACH, UNMARKED);
      expect(routedToReview(), `pause ${i + 1}`).toBe(true);
    }
  });

  it("a binding written before steps were bound (rolling upgrade): the pause is classified by the live row, as before; never stopped", async () => {
    await pauseBound("none", OUTREACH);
    expect(routedToReview()).toBe(true);
    vi.clearAllMocks();
    await pauseBound("none", UNMARKED);
    expect(routedToReview()).toBe(false);
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    // A live read that fails reads as no template, the road main takes: the pause is offered, the run not stopped.
    await pauseBound("none", new Error("template store down"));
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith("run-rev-1", "running", "failed", expect.anything(), expect.anything());
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
  });

  it("a binding that records no steps (the loader sent no source, or it did not compile): the run stops after the retries, whatever the row says", async () => {
    await pauseBound(null, OUTREACH);
    stoppedWith("PAUSE_POLICY_UNREAD");
    expect(storeMock.readRunPauseSteps).toHaveBeenCalledTimes(1 + PAUSE_POLICY_READ_WAITS_MS.length);
    expect(onInterruptSpy).not.toHaveBeenCalled();
  });

  it("a claim another runtime signed for its own task (a child agent's pause) does not verify here: the run is stopped", async () => {
    await pause(signedClaim("drafts-approval_gate", KEY, "ctx-child-agent", "task-child-agent"), 1);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("ARTIFACT_REVIEW_GATE_UNVERIFIED");
  });

  it("steps that cannot be read on a run whose produced output awaits review: the run holds at that review, it is not failed", async () => {
    holdMock.holdRunForProducedReview.mockResolvedValueOnce({ held: true, reason: "parked" });
    await pauseBound(null, OUTREACH);
    expect(holdMock.holdRunForProducedReview).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-rev-1", withheld: expect.objectContaining({ status: "failed", error: expect.stringMatching(/^PAUSE_POLICY_UNREAD: /) }) }),
      TEST_AUTHORITY,
    );
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith("run-rev-1", "running", "failed", expect.anything(), expect.anything());
  });

  it("the unplaced-pause stop ends the durable AG-UI log: RUN_ERROR is published with the stop's text", async () => {
    await pauseBound(null, OUTREACH);
    expect(publishSpy).toHaveBeenCalledWith("run-rev-1", expect.objectContaining({ type: "RUN_ERROR", message: expect.stringMatching(/^PAUSE_POLICY_UNREAD: /) }));
    stoppedWith("PAUSE_POLICY_UNREAD");
  });

  it("an unverified node on a claimed resume leg: the stop carries the leg, so a stale leg cannot fail a newer attempt", async () => {
    bindTemplate(makeTemplate(OUTREACH));
    gateIndexSpy.mockResolvedValue(1);
    const run = makeRun({ ...RUN_INPUTS });
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(null),
      claimedGate: { a2aTaskId: "task-gate-0", executionAttemptId: "attempt-1" },
    });
    expect(storeMock.transitionRunStatus).toHaveBeenCalledWith(
      "run-rev-1", "running", "failed",
      expect.objectContaining({ error: expect.stringMatching(/^ARTIFACT_REVIEW_GATE_UNVERIFIED: /), resumeLeg: { a2aTaskId: "task-rev-1", executionAttemptId: "attempt-1" } }),
      TEST_AUTHORITY,
    );
  });
});
