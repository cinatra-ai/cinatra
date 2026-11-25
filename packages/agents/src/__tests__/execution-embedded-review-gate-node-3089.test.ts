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

const { enrichSpy, onInterruptSpy, gateIndexSpy } = vi.hoisted(() => {
  const enrichSpy = vi.fn(async (schema: unknown) => ({ ...(schema as object) }));
  const onInterruptSpy = vi.fn();
  const gateIndexSpy = vi.fn(async () => 0);
  return { enrichSpy, onInterruptSpy, gateIndexSpy };
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
  storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate(steps));
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

  it("a template read that throws is retried in the handler: the read that works decides the pause by its node as usual", async () => {
    storeMock.readAgentTemplateById.mockReset();
    // The claim verifies, so the publish classification reads nothing; the
    // pause's first read fails and its retry succeeds.
    storeMock.readAgentTemplateById
      .mockRejectedValueOnce(new Error("store blip"))
      .mockResolvedValue(makeTemplate(OUTREACH));
    gateIndexSpy.mockResolvedValue(0);
    const run = makeRun({ ...RUN_INPUTS, reviewTargets: TARGETS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(run.id, "running", "failed", expect.anything(), expect.anything());
    // red-first-expect: expected "vi.fn()" to be called at least once
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("a template read that throws in every attempt stops the run after the bounded retries: nothing is offered", async () => {
    storeMock.readAgentTemplateById.mockReset();
    storeMock.readAgentTemplateById.mockRejectedValue(new Error("store down"));
    gateIndexSpy.mockResolvedValue(1);
    const run = makeRun({ ...RUN_INPUTS });
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("PAUSE_POLICY_UNREAD");
    // The pause's first read and its retries (the verified claim needs no publish read).
    expect(storeMock.readAgentTemplateById).toHaveBeenCalledTimes(1 + PAUSE_POLICY_READ_WAITS_MS.length);
  });

  // A run pinned to v1 (an explicit version: versionId AND packageVersion). The
  // flow that runs is the INSTALLED package (one directory per package name),
  // whose version is the live template row's packageVersion.
  const V2_DRAFTS = { ...DRAFTS_STEP } as Record<string, unknown>;
  delete V2_DRAFTS.artifactReviewTargetsInput;
  delete V2_DRAFTS.artifactReviewGateNode;
  const UNMARKED = [RECIPIENTS_STEP, V2_DRAFTS, SEND_STEP];
  const v1Row = (steps: Array<Record<string, unknown>>) => ({ templateId: "tmpl-rev-1", semver: "1.0.0", snapshot: { compiledPlan: [], taskSpec: null, approvalPolicy: { steps } } });
  const V1_ROW = v1Row(OUTREACH);
  async function pinnedPause(row: unknown, installed: { version: string | null; steps: Array<Record<string, unknown>> } | null = { version: null, steps: UNMARKED }) {
    storeMock.readAgentTemplateById.mockReset();
    storeMock.readAgentTemplateById.mockResolvedValue(installed === null ? null : makeTemplate(installed.steps, installed.version));
    storeMock.readAgentTemplateVersionById.mockReset();
    if (row instanceof Error) storeMock.readAgentTemplateVersionById.mockRejectedValue(row);
    else storeMock.readAgentTemplateVersionById.mockResolvedValue(row as never);
    gateIndexSpy.mockResolvedValue(1);
    const run = { ...makeRun({ ...RUN_INPUTS, reviewTargets: TARGETS }), versionId: "ver-1", packageVersion: "1.0.0" } as AgentRunRecord;
    await handleWayflowTaskState({ authority: TEST_AUTHORITY, runId: run.id, run, fromStatus: "running", task: pausedTask(signedClaim("drafts-approval_gate")) });
  }

  it("a pinned run whose version is the installed one is classified by the pinned version's policy, as before", async () => {
    await pinnedPause(V1_ROW, { version: "1.0.0", steps: OUTREACH });
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
    expect(storeMock.readAgentTemplateVersionById).toHaveBeenCalledWith("ver-1");
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", expect.anything(), expect.anything());
  });

  it("version 2 installed over version 1, a run requesting version 1: the pause is not classified by version 1's marker; the run stops", async () => {
    await pinnedPause(V1_ROW, { version: "2.0.0", steps: UNMARKED });
    // red-first-expect: expected "vi.fn()" to not be called at all
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("PAUSE_POLICY_VERSION_MISMATCH");
    // A version mismatch is no read fault: it is not retried.
    expect(storeMock.readAgentTemplateVersionById).toHaveBeenCalledTimes(1);
  });

  it("a review marker only the installed version 2 carries is never degraded to an ordinary approval of version 1", async () => {
    await pinnedPause(v1Row(UNMARKED), { version: "2.0.0", steps: OUTREACH });
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "pending_approval", expect.anything(), expect.anything(),
    );
    stoppedWith("PAUSE_POLICY_VERSION_MISMATCH");
  });

  it("another version installed with the same steps: the pause is classified as usual", async () => {
    await pinnedPause(V1_ROW, { version: "2.0.0", steps: OUTREACH });
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", expect.anything(), expect.anything());
  });

  // The same content with every object's keys written in reverse order.
  const reversedKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reversedKeys)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)])) : v;

  it("another version installed with the same steps written in another key order: the pause is classified as usual", async () => {
    await pinnedPause(v1Row(reversedKeys(OUTREACH) as Array<Record<string, unknown>>), { version: "2.0.0", steps: OUTREACH });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "failed", expect.anything(), expect.anything());
    expect(emitSpy).toHaveBeenCalled();
    expect(routedToReview()).toBe(true);
  });

  it("another version installed with the same steps in another order: the steps differ, the run stops", async () => {
    await pinnedPause(v1Row([...OUTREACH].reverse()), { version: "2.0.0", steps: OUTREACH });
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("PAUSE_POLICY_VERSION_MISMATCH");
  });

  it("a pinned run whose template row is gone: which version ran is not known, so the run stops after the retries; no step-less approval", async () => {
    await pinnedPause(V1_ROW, null);
    expect(onInterruptSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    stoppedWith("PAUSE_POLICY_UNREAD");
    expect(storeMock.readAgentTemplateById).toHaveBeenCalledTimes(1 + PAUSE_POLICY_READ_WAITS_MS.length);
  });

  it("a pinned run whose snapshot is missing, unreadable or carries no policy stops after the retries; the live policy is never used", async () => {
    const noPolicy = { ...V1_ROW, snapshot: { compiledPlan: [], taskSpec: null } };
    for (const row of [null, new Error("snapshot store down"), noPolicy]) {
      storeMock.transitionRunStatus.mockClear();
      onInterruptSpy.mockClear();
      emitSpy.mockClear();
      await pinnedPause(row);
      expect(onInterruptSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
      stoppedWith("PAUSE_POLICY_UNREAD");
      expect(storeMock.readAgentTemplateVersionById).toHaveBeenCalledTimes(1 + PAUSE_POLICY_READ_WAITS_MS.length);
    }
  }, 15_000);

  it("a claim another runtime signed for its own task (a child agent's pause) does not verify here: the run is stopped", async () => {
    await pause(signedClaim("drafts-approval_gate", KEY, "ctx-child-agent", "task-child-agent"), 1);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(onInterruptSpy).not.toHaveBeenCalled();
    stoppedWith("ARTIFACT_REVIEW_GATE_UNVERIFIED");
  });
});
