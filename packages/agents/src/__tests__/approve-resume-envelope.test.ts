/**
 * Agent-run A2A resume + WayFlow text-only user envelope contract.
 *
 * The HITL approval may submit `userResponse` as a JSON-stringified
 * envelope `{text: string, attachments?: LlmAttachmentRef[]}` to round-trip
 * artifact refs back into the agent run. The cinatra side passes this
 * payload through to the A2A sendTask as a TEXT-ONLY part — A2A messages
 * stay text-only by design. WayFlow then forwards body verbatim to
 * /api/llm-bridge; if WayFlow sets `body.user_envelope=true`, the bridge
 * opt-in parser extracts the embedded attachments.
 *
 * These tests assert the cinatra-side invariants:
 *   (a) sendTask.parts has a single text part.
 *   (b) the text content equals the userResponse envelope verbatim.
 *   (c) submittedValues parses the {text, attachments} JSON correctly.
 *   (d) the legacy plain-string userResponse path is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// cinatra#4150: every resume road reads the run's newest publish decision before it
// sends. This suite is about another question, so no publish decision holds its run.
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));

type SendTaskInput = {
  message?: { parts?: Array<{ kind?: string; text?: string }> };
};
const sendTaskMock = vi.fn(async (_input: SendTaskInput) => ({
  id: "task-resume",
  status: { state: "completed" },
  contextId: "ctx-r1",
}));

// cinatra#2485 C: the install-scope run gate reads the agent_runs /
// agent_templates rows straight from the DB (no live Postgres in this suite).
// The gate's own behavior is proven in `agent-template-scope.test.ts`,
// `agent-run-scope-guard.test.ts` and `agent-run-scope-enforcement-wiring.test.ts`
// (which pins that THIS call site keeps its assertion).
// cinatra#4245: the resume road's pause claim always wins here.
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));

const dbWrites: Array<{ op: string; table: string; set: unknown }> = [];
const dbMock = vi.hoisted(() => {
  const update = vi.fn((_table: unknown) => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn(async () => {
        // captured via dbWrites in beforeEach scope below.
      }),
    })),
  }));
  return { update };
});
vi.mock("../db", () => ({
  db: dbMock,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

type WriteHitlPromptInput = {
  submittedValues?: { text?: string; attachments?: unknown };
};
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  // #1193: each resume leg mints + records its own per-run credential before the
  // blocking sendTask. Recording is ADDITIVE (earlier legs stay valid).
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  writeHitlPrompt: vi.fn(async (_input: { submittedValues?: unknown }) => undefined),
  // cinatra#3423: the answer CLAIMS the gate with one conditional transition
  // before it records anything or dispatches. This suite is about the envelope
  // on the wire, so the claim simply succeeds here — the race it settles has its
  // own suite (review-gate-decided-once-3423).
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
const continueMock = vi.hoisted(() => ({
  // No durable gate by default: the Continue receipt is not written.
  readDurableHitlGateForContinue: vi.fn<(runId?: string, reviewTaskId?: string) => Promise<unknown>>(async () => null),
  // The run's current gate (its newest durable row): by default the record the
  // suite gives for the gate it answers.
  readCurrentDurableHitlGate: vi.fn<(runId: string) => Promise<unknown>>(async () => null),
  recordSuccessfulContinue: vi.fn(async (_input: { submittedValues: unknown }) => {}),
}));
const currentIsTheAnsweredGate = (runId: string) => continueMock.readDurableHitlGateForContinue(runId, "current");
continueMock.readCurrentDurableHitlGate.mockImplementation(currentIsTheAnsweredGate);
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await storeMock.writeHitlPrompt(input); return "captured-prompt";
  },
  readDurableHitlGateForContinue: continueMock.readDurableHitlGateForContinue,
  readCurrentDurableHitlGate: continueMock.readCurrentDurableHitlGate,
  recordSuccessfulContinue: continueMock.recordSuccessfulContinue,
  continueBindingDigest: () => "", continueGateDigest: () => "",
}));

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));

// The run's latest-task key and the reverse task-run map: none by default.
const runKeys = vi.hoisted(() => ({
  latest: vi.fn<(runId: string) => Promise<string | null>>(async () => null),
  runOfTask: vi.fn<(taskId: string) => Promise<string | null>>(async () => null),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: sendTaskMock,
  })),
  resolveLatestWayflowGateTaskId: runKeys.latest,
  resolveRunIdByWayflowTaskId: runKeys.runOfTask,
  // #1987 — the wayflow- resume mints answered-gate provenance (and re-asserts
  // the latest-task join key) before dispatch; stub both so the resume proceeds.
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: vi.fn(async () => {}),
}));

// Avoid pulling the full execution graph for downstream state handling.
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async () => undefined),
}));

// cinatra#1939 wave 2: the wayflow resume mints the resuming-principal
// authority (§2d) via resolveOrgRoleForUser. Stub only that membership read (a
// DB call) so the mint stays DB-free; sessionAuthorityFromResolvedRole remains
// the real (pure) function. Owner ruling 2026-07-26 (ruling 2): a non-member
// principal (resolveOrgRoleForUser → undefined) now fails closed.
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { approveReviewTaskInternal } from "../review-task-actions";
import * as gateSubmit from "../hitl-gate-submit";
import { pauseClaimFake } from "./pause-claim-test-fake";
import { applyAttachmentEnvelope } from "../attachment-envelope-payload";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import * as midRun from "../orchestrator-mid-run-hitl";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

const REF = {
  artifactId: "art-1",
  // The bridge user_envelope schema strictly requires
  // `representationRevisionId`. The envelope is
  // forwarded verbatim by WayFlow to /api/llm-bridge with
  // user_envelope=true, so this test fixture must mirror the bridge's
  // post-rename strict schema or the resume turn would 400 in prod.
  representationRevisionId: "ver-1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload" as const,
  filename: "report.pdf",
};

function setupRun(): void {
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-r1",
    templateId: "tpl-int",
    status: "pending_approval",
    a2aContextId: "ctx-r1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-int",
    packageName: "@cinatra-ai/email-outreach-agent",
    sourceType: "internal",
  });
}

describe("agent-run resume + WayFlow text-only envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites.length = 0;
    setupRun();
  });

  it("legacy plain-string userResponse: sendTask part text equals the string verbatim", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: "approve",
    });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    expect(call?.message?.parts).toHaveLength(1);
    expect(call?.message?.parts?.[0]?.kind).toBe("text");
    expect(call?.message?.parts?.[0]?.text).toBe("approve");
  });

  it("envelope userResponse: sendTask STAYS text-only; text is the JSON envelope verbatim", async () => {
    const envelope = JSON.stringify({ text: "see attached", attachments: [REF] });
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: envelope,
    });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    // A2A invariant — exactly ONE text part, no file parts.
    expect(call?.message?.parts).toHaveLength(1);
    expect(call?.message?.parts?.[0]?.kind).toBe("text");
    expect(call?.message?.parts?.[0]?.text).toBe(envelope);
  });

  it("envelope userResponse: writeHitlPrompt submittedValues round-trips {text, attachments}", async () => {
    const env = { text: "see attached", attachments: [REF] };
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: JSON.stringify(env),
    });
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
    const arg = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as unknown as {
      submittedValues?: { text?: string; attachments?: typeof env.attachments };
    };
    expect(arg?.submittedValues?.text).toBe("see attached");
    expect(arg?.submittedValues?.attachments).toEqual([REF]);
  });

  it("bare approval (no userResponse, no note): sendTask text is the canonical marker", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", undefined);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    expect(call?.message?.parts?.[0]?.text).toBe("[Approved by operator]");
  });

  // Owner ruling 2026-07-26 (ruling 2): cross-org run management is unsupported.
  // A resuming principal who is NOT a member of the run's org (resolveOrgRoleForUser
  // → undefined) fails closed BEFORE any WayFlow send — no non-member mint.
  it("non-member principal (ruling 2): refuses and dispatches NO WayFlow send", async () => {
    (resolveOrgRoleForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(
      approveReviewTaskInternal("wayflow-task-r1", "actor-1", { userResponse: "approve" }),
    ).rejects.toThrow(/cross-org run management is unsupported/);
    expect(sendTaskMock).not.toHaveBeenCalled();
  });
});

// cinatra#3562, a list step's picks reach the run: END TO END from the
// payload a run surface builds for a mid-run list step to the text WayFlow
// receives. The server sends a nonblank `userResponse` before `approvalNote`,
// so the list step's payload must carry no `userResponse` of its own.
describe("a list step's picks reach the run (cinatra#3562)", () => {
  const LIST = "@cinatra-ai/email-outreach-agent:list-picker";
  const BUFFERED = { listIds: ["L1"], listNames: ["One"], userResponse: "continue" };

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
  });

  function sentText(): string | undefined {
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    return call?.message?.parts?.[0]?.text;
  }

  /** The payload the run surfaces build at the list step's Continue. */
  function listStepPayload(): Record<string, unknown> {
    const apply = gateSubmit.applyRendererApprovalNote;
    expect(typeof apply).toBe("function");
    const lift = gateSubmit.liftRendererApprovalNote(LIST, BUFFERED);
    return apply(LIST, { ...BUFFERED, approved: true, approvedAt: "2026-11-08T00:00:00.000Z" }, lift);
  }

  it("the server sends a nonblank userResponse before the note (the precedence the payload must meet)", async () => {
    const note = gateSubmit.liftRendererApprovalNote(LIST, BUFFERED)!.approvalNote;
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      ...BUFFERED,
      approvalNote: note,
    });
    expect(sentText()).toBe("continue");
  });

  it("a list step's payload resumes the run with the snapshot of its picks", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", listStepPayload());
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sentText()!)).toMatchObject({
      type: "list",
      listIds: ["L1"],
      listNames: ["One"],
    });
  });

  it("with an attachment, the envelope wraps the snapshot of the picks", async () => {
    const payload = applyAttachmentEnvelope(listStepPayload(), [REF]);
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", payload);
    const envelope = JSON.parse(sentText()!) as { text: string; attachments: unknown[] };
    expect(envelope.attachments).toEqual([REF]);
    expect(JSON.parse(envelope.text)).toMatchObject({ type: "list", listIds: ["L1"] });
  });
});

// A step recorded under the plain form's own id (a step that declares no screen
// of its own, as the publish packs' review step does) is drawn by the schema
// floor. END TO END from the answer a host builds for it (the floor's own
// payload) to the text WayFlow receives: the written note, not
// "[Approved by operator]". A step whose id no entry claims gets no renderer.
const FLOOR_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;

function registerFloorOnly(): void {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: FLOOR_ID,
    priority: 1,
    condition: (_f, schema) => schema["x-renderer"] === FLOOR_ID,
    renderer: () => null,
    drawsOwnSubmit: true,
  });
}

function wayflowText(): string | undefined {
  const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
    message?: { parts?: Array<{ kind?: string; text?: string }> };
  };
  return call?.message?.parts?.[0]?.text;
}

const floorFor = (schema: Record<string, unknown>, xRenderer: string = FLOOR_ID) =>
  midRun.resolveHitlGateRenderer("hitl", { ...schema, "x-renderer": xRenderer }, { connectedApps: [] });

describe("a gate the schema floor draws resumes with the written note", () => {
  const SCHEMA = { type: "object", properties: { note: { type: "string", title: "Note" } } };

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    registerFloorOnly();
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("the host's answer for the floor-drawn gate reaches WayFlow as the note", async () => {
    const entry = floorFor(SCHEMA);
    expect(entry?.id).toBe(FLOOR_ID);
    const { payload, payloadFieldName } = gateSubmit.buildFieldGateAnswer({
      drawnByFloor: midRun.gateDrawnBySchemaFloor(FLOOR_ID, entry),
      reviewTaskId: "wayflow-task-r1",
      fieldName: undefined,
      next: { note: "Go ahead." },
      schema: SCHEMA,
    });
    expect(payloadFieldName).toBeUndefined();
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", payload as Record<string, unknown>);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(wayflowText()).toBe("Go ahead.");
  });

  it("the raw field answer (the setup-loop shape) would resume with the bare marker", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { note: "Go ahead." });
    expect(wayflowText()).toBe("[Approved by operator]");
  });

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("a step whose id no entry claims gets no renderer, so no answer is built for it", () => {
    for (const id of [
      "@cinatra-test/never-seen-agent:screen",
      "@cinatra-ai/blog-pipeline-agent:idea-selection",
    ]) {
      expect(floorFor(SCHEMA, id), id).toBeNull();
    }
  });
});

// Every shape the schema floor answers: the answer each host builds (the run
// panel and the card through `buildFieldGateAnswer`, the stepper through
// `buildSchemaFloorGatePayload`) is the same, and through the real server
// boundary WayFlow receives the entered value, never the marker.
describe("a gate the schema floor draws resumes with the entered value, for every shape", () => {
  const TASK = "wayflow-task-r1";

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    registerFloorOnly();
  });

  const CASES: Array<{ shape: string; schema: Record<string, unknown>; next: unknown; text: string }> = [
    { shape: "string", schema: { type: "string", title: "Answer" }, next: "Ship it.", text: "Ship it." },
    { shape: "number", schema: { type: "number", title: "Count" }, next: 42, text: "42" },
    { shape: "integer", schema: { type: "integer", title: "Count" }, next: 0, text: "0" },
    { shape: "boolean", schema: { type: "boolean", title: "Agree" }, next: false, text: "false" },
    {
      shape: "array",
      schema: { type: "array", items: { type: "string" } },
      next: ["alpha", "beta"],
      text: '["alpha","beta"]',
    },
    {
      shape: "object",
      schema: {
        type: "object",
        properties: { note: { type: "string" }, count: { type: "number" } },
      },
      next: { note: "Go", count: 2 },
      text: '{"note":"Go","count":2}',
    },
  ];

  for (const c of CASES) {
    // red-first-expect: resolveHitlGateRenderer is not a function
    it(`a ${c.shape} gate delivers the entered value, and the three hosts build the same answer`, async () => {
      const entry = floorFor(c.schema);
      expect(entry?.id).toBe(FLOOR_ID);
      // The run panel and the card.
      const { payload, payloadFieldName } = gateSubmit.buildFieldGateAnswer({
        drawnByFloor: midRun.gateDrawnBySchemaFloor(FLOOR_ID, entry),
        reviewTaskId: TASK,
        fieldName: undefined,
        next: c.next,
        schema: c.schema,
      });
      expect(payloadFieldName).toBeUndefined();
      // The stepper.
      const stepper = gateSubmit.buildSchemaFloorGatePayload({ schema: c.schema, next: c.next });
      const { approvedAt: _a, ...hostAnswer } = payload as Record<string, unknown>;
      const { approvedAt: _b, ...stepperAnswer } = stepper;
      void _a;
      void _b;
      expect(hostAnswer).toEqual(stepperAnswer);
      expect(hostAnswer).toMatchObject({ approved: true, userResponse: c.text });
      await approveReviewTaskInternal(TASK, "actor-1", payload as Record<string, unknown>);
      expect(sendTaskMock).toHaveBeenCalledTimes(1);
      expect(wayflowText()).toBe(c.text);
    });
  }

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("a text gate with a field name records the answer under it", async () => {
    const schema = { type: "string", title: "Answer" };
    const { payload } = gateSubmit.buildFieldGateAnswer({
      drawnByFloor: midRun.gateDrawnBySchemaFloor(FLOOR_ID, floorFor(schema)),
      reviewTaskId: TASK,
      fieldName: "answer",
      next: "Ship it.",
      schema,
    });
    expect(payload).toMatchObject({
      answer: "Ship it.",
      userResponse: "Ship it.",
      userResponseFieldName: "answer",
    });
    expect(gateSubmit.readWayflowSubmittedValues(payload)).toEqual({ answer: "Ship it." });
    await approveReviewTaskInternal(TASK, "actor-1", payload as Record<string, unknown>);
    expect(wayflowText()).toBe("Ship it.");
  });

  // red-first-expect: buildSchemaFloorGatePayload is not a function
  it("a blank text or an empty list carries no resume text", () => {
    expect(
      gateSubmit.buildSchemaFloorGatePayload({ schema: { type: "string" }, next: "  " }),
    ).not.toHaveProperty("userResponse");
    expect(
      gateSubmit.buildSchemaFloorGatePayload({
        schema: { type: "array", items: { type: "string" } },
        next: [],
      }),
    ).not.toHaveProperty("userResponse");
  });
});

// A NAMED number, boolean or list answer keeps its field in the durable record,
// as a named text does: the prompt record's submitted values and the Continue
// receipt carry `{ answer: <value> }`, while WayFlow receives the same resume
// text as without the name.
describe("a named number, boolean or list answer survives in the durable record", () => {
  const TASK = "wayflow-task-r1";
  const GATE = {
    runId: "run-r1",
    reviewTaskId: TASK,
    xRenderer: FLOOR_ID,
    inputSchema: {},
    values: {},
    materializedAt: "2026-11-24T00:00:00.000Z",
  };
  const NAMED: Array<{ shape: string; schema: Record<string, unknown>; value: unknown; text: string }> = [
    { shape: "number", schema: { type: "number" }, value: 42, text: "42" },
    { shape: "boolean", schema: { type: "boolean" }, value: false, text: "false" },
    { shape: "list", schema: { type: "array", items: { type: "string" } }, value: ["a"], text: '["a"]' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    registerFloorOnly();
    continueMock.readDurableHitlGateForContinue.mockResolvedValue({ ...GATE });
  });

  for (const c of NAMED) {
    // red-first-expect: buildSchemaFloorGatePayload is not a function
    it(`a ${c.shape} answer under a field name is written, read back and receipted under that name`, async () => {
      const payload = gateSubmit.buildSchemaFloorGatePayload({
        schema: c.schema,
        next: c.value,
        fieldName: "answer",
      });
      expect(payload).toMatchObject({ userResponse: c.text, userResponseFieldName: "answer" });
      expect(gateSubmit.readWayflowSubmittedValues(payload)).toEqual({ answer: c.value });
      // A read of a stored copy (the record is JSON in the database).
      expect(gateSubmit.readWayflowSubmittedValues(JSON.parse(JSON.stringify(payload)))).toEqual({
        answer: c.value,
      });
      await approveReviewTaskInternal(TASK, "actor-1", payload);
      expect(wayflowText()).toBe(c.text);
      const written = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
      expect(written?.submittedValues).toEqual({ answer: c.value });
      expect(continueMock.recordSuccessfulContinue).toHaveBeenCalledTimes(1);
      const receipted = continueMock.recordSuccessfulContinue.mock.calls[0]?.[0];
      expect(receipted?.submittedValues).toEqual({ answer: c.value });
    });
  }

  // red-first-expect: buildSchemaFloorGatePayload is not a function
  it("without a field name the resume text is the same", async () => {
    for (const c of NAMED) {
      const payload = gateSubmit.buildSchemaFloorGatePayload({ schema: c.schema, next: c.value });
      expect(payload.userResponse).toBe(c.text);
    }
  });
});

// AN UNNAMED ANSWER IS KEPT TOO. An ordinary WayFlow gate carries no field
// name, so the floor's answer is written under `hitl-field` (the name the plain
// form and the read-only replay give a single field with no name of its own),
// with its own type. The prompt record and the Continue receipt carry it, and
// WayFlow receives the same resume text as before. `null`, a blank text and an
// empty list send the marker, as before, and are still kept in the record.
describe("an unnamed answer of any type survives in the durable record", () => {
  const TASK = "wayflow-task-r1";
  const KEY = "hitl-field";
  const GATE = {
    runId: "run-r1",
    reviewTaskId: TASK,
    xRenderer: FLOOR_ID,
    inputSchema: {},
    values: {},
    materializedAt: "2026-11-24T00:00:00.000Z",
  };
  const UNNAMED: Array<{ label: string; schema: Record<string, unknown>; value: unknown; text: string }> = [
    { label: "42", schema: { type: "number" }, value: 42, text: "42" },
    { label: "0", schema: { type: "integer" }, value: 0, text: "0" },
    { label: "false", schema: { type: "boolean" }, value: false, text: "false" },
    { label: '["a"]', schema: { type: "array", items: { type: "string" } }, value: ["a"], text: '["a"]' },
    { label: "empty text", schema: { type: "string" }, value: "", text: "[Approved by operator]" },
    { label: "null", schema: { type: "string" }, value: null, text: "[Approved by operator]" },
    { label: "a text", schema: { type: "string" }, value: "Ship it.", text: "Ship it." },
    { label: "a JSON-looking text", schema: { type: "string" }, value: "42", text: "42" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    registerFloorOnly();
    continueMock.readDurableHitlGateForContinue.mockResolvedValue({ ...GATE });
  });

  for (const c of UNNAMED) {
    // red-first-expect: buildSchemaFloorGatePayload is not a function
    it(`an unnamed ${c.label} answer is written, read back and receipted`, async () => {
      const payload = gateSubmit.buildSchemaFloorGatePayload({ schema: c.schema, next: c.value });
      expect(gateSubmit.readWayflowSubmittedValues(payload)).toEqual({ [KEY]: c.value });
      expect(gateSubmit.readWayflowSubmittedValues(JSON.parse(JSON.stringify(payload)))).toEqual({
        [KEY]: c.value,
      });
      await approveReviewTaskInternal(TASK, "actor-1", payload);
      expect(wayflowText()).toBe(c.text);
      const written = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
      expect(written?.submittedValues).toEqual({ [KEY]: c.value });
      // The stored record read back through a JSON copy keeps the value and its type.
      expect(JSON.parse(JSON.stringify(written?.submittedValues))).toEqual({ [KEY]: c.value });
      expect(continueMock.recordSuccessfulContinue).toHaveBeenCalledTimes(1);
      expect(continueMock.recordSuccessfulContinue.mock.calls[0]?.[0]?.submittedValues).toEqual({
        [KEY]: c.value,
      });
    });
  }

  // red-first-expect: buildSchemaFloorGatePayload is not a function
  it("nothing entered writes no answer", () => {
    const payload = gateSubmit.buildSchemaFloorGatePayload({ schema: { type: "number" }, next: undefined });
    expect(payload).not.toHaveProperty(KEY);
    expect(payload).not.toHaveProperty("userResponse");
  });
});

// A DISPLAY-ONLY CARD AND AN UNREADABLE RECORD ARE REFUSED BY THE GENERIC ANSWER.
// The artifact-review redirect draws no answer of its own: only its review's
// decision consumes the pause (the resume delivery, which never takes this
// action). A durable record that cannot be read refuses with a fixed text; only a
// real absence (`null`) goes on as before. Nothing is claimed, recorded or sent
// on a refusal.
describe("the generic answer and the paused step's durable record", () => {
  const TASK = "wayflow-task-r1";
  const gateFor = (xRenderer: string) => ({
    runId: "run-r1",
    reviewTaskId: TASK,
    xRenderer,
    inputSchema: { type: "object" },
    values: {},
    materializedAt: "2026-11-25T00:00:00.000Z",
  });
  const nothingMoved = () => {
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(sendTaskMock).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    continueMock.readDurableHitlGateForContinue.mockReset().mockResolvedValue(null);
    continueMock.readCurrentDurableHitlGate.mockReset().mockImplementation(currentIsTheAnsweredGate);
    runKeys.latest.mockReset().mockResolvedValue(null);
    runKeys.runOfTask.mockReset().mockResolvedValue(null);
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("a pause on the display-only artifact-review redirect is refused and not consumed", async () => {
    continueMock.readDurableHitlGateForContinue.mockResolvedValue(
      gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"),
    );
    await expect(
      approveReviewTaskInternal(TASK, "actor-1", { approved: true, approvedAt: "2026-11-25T00:00:00.000Z" }),
    ).rejects.toMatchObject({
      name: "HitlStepNotAnswerableError",
      message: "WayFlow approval rejected: gate task-r1 on run run-r1 is an artifact review; it goes on only when that review is decided",
    });
    nothingMoved();
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("a durable record that cannot be read refuses with a fixed text; nothing is claimed or sent", async () => {
    continueMock.readDurableHitlGateForContinue.mockRejectedValue(
      new Error("permission denied for table agent_run_hitl_gates"),
    );
    await expect(
      approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" }),
    ).rejects.toThrow(
      /^WayFlow approval rejected: the paused step of gate task-r1 on run run-r1 could not be read$/,
    );
    nothingMoved();
  });

  it("no durable record (a real null) is answered as before", async () => {
    await approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" });
    expect(continueMock.readDurableHitlGateForContinue).toHaveBeenCalledWith("run-r1", TASK);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(wayflowText()).toBe("go");
  });

  // THE RUN'S CURRENT GATE DECIDES (its newest durable row), and an answer to
  // another task is refused as no longer the pause the run waits at.
  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("an answer to an older gate is refused when the run's current gate is a display-only card", async () => {
    // The run's latest-task key names the newer task: the run waits there.
    runKeys.latest.mockResolvedValue("task-r2");
    continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:schema-field-fallback"));
    continueMock.readCurrentDurableHitlGate.mockResolvedValue({
      ...gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"),
      reviewTaskId: "wayflow-task-r2",
    });
    await expect(
      approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" }),
    ).rejects.toMatchObject({
      name: "GateNotPendingError",
      message: "WayFlow approval rejected: gate task-r1 on run run-r1 is no longer the pause the run waits at",
    });
    nothingMoved();
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("an answer to an older display-only gate is refused as stale, not as that card", async () => {
    runKeys.latest.mockResolvedValue("task-r2");
    continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"));
    continueMock.readCurrentDurableHitlGate.mockResolvedValue({
      ...gateFor("@cinatra-ai/agent-builder:schema-field-fallback"),
      reviewTaskId: "wayflow-task-r2",
    });
    await expect(
      approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" }),
    ).rejects.toMatchObject({
      name: "GateNotPendingError",
      message: "WayFlow approval rejected: gate task-r1 on run run-r1 is no longer the pause the run waits at",
    });
    nothingMoved();
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("the current gate is read for the run, and its refusal stands whatever the named row says", async () => {
    continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:schema-field-fallback"));
    continueMock.readCurrentDurableHitlGate.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"));
    await expect(
      approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" }),
    ).rejects.toMatchObject({ name: "HitlStepNotAnswerableError" });
    expect(continueMock.readCurrentDurableHitlGate).toHaveBeenCalledWith("run-r1");
    nothingMoved();
  });

  it("an ordinary builder input step still answers", async () => {
    for (const id of [
      "@cinatra-ai/agent-builder:schema-field-fallback",
      "@cinatra-ai/agent-builder:grouped-setup-form",
      "@cinatra-ai/agent-builder:skill-selector",
    ]) {
      sendTaskMock.mockClear();
      continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor(id));
      await approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" });
      expect(sendTaskMock, id).toHaveBeenCalledTimes(1);
      expect(wayflowText(), id).toBe("go");
    }
  });

  // The server does not judge whether a page draws the step: a renderer id no
  // registered screen claims is answered as it always was.
  it("a step whose renderer id no registered screen claims is answered as before", async () => {
    continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor("@acme/removed:output"));
    await approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(wayflowText()).toBe("go");
  });

  // THE SERVER REFUSES WHAT THE HOSTS WITHHOLD: a retired step (the set every
  // host draws no Continue for) is answered by nothing, under any id of it.
  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("a pause on any retired step is refused and not consumed", async () => {
    const retired = [
      ...midRun.TOMBSTONED_HITL_RENDERER_IDS,
      `${[...midRun.TOMBSTONED_HITL_RENDERER_PACKAGES][0]}:any-step`,
    ];
    for (const id of retired) {
      expect(midRun.parkedHitlStepIsAnswerable(id, null), id).toBe(false);
      continueMock.readDurableHitlGateForContinue.mockResolvedValue(gateFor(id));
      await expect(
        approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" }),
        id,
      ).rejects.toMatchObject({
        name: "HitlStepNotAnswerableError",
        message: "WayFlow approval rejected: gate task-r1 on run run-r1 is a retired step; it can no longer be answered",
      });
      nothingMoved();
    }
  });
});

// WHICH STEP THE RUN WAITS AT IS DECIDED BY THE RUN ROW AND ITS LATEST-TASK KEY,
// never by a durable step row: that row's write is best-effort, so step A's row
// can be the newest while the run waits at step B, whose row was never written.
describe("the generic answer when the step's durable row was not written", () => {
  const STEP_A = "task-a";
  const STEP_B = "task-b";
  const rowOfA = {
    runId: "run-r1",
    reviewTaskId: `wayflow-${STEP_A}`,
    xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
    inputSchema: { type: "object" },
    values: {},
  };
  const runAtB = {
    id: "run-r1",
    templateId: "tpl-int",
    status: "pending_approval",
    a2aTaskId: STEP_B,
    a2aContextId: "ctx-r1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    // The run waits at B: its row names B, and so does its latest-task key.
    storeMock.readAgentRunByTaskId.mockImplementation(async (taskId: string) => (taskId === STEP_B ? runAtB : null));
    storeMock.readAgentRunById.mockResolvedValue(runAtB);
    runKeys.latest.mockReset().mockResolvedValue(STEP_B);
    runKeys.runOfTask.mockReset().mockImplementation(async () => "run-r1");
    // Step A's row was written; step B's write failed, so A's row is the newest.
    continueMock.readDurableHitlGateForContinue.mockReset().mockImplementation(
      async (_runId?: string, reviewTaskId?: string) => (reviewTaskId === rowOfA.reviewTaskId ? rowOfA : null),
    );
    continueMock.readCurrentDurableHitlGate.mockReset().mockResolvedValue(rowOfA);
  });
  afterEach(() => {
    runKeys.latest.mockReset().mockResolvedValue(null);
    runKeys.runOfTask.mockReset().mockResolvedValue(null);
    storeMock.readAgentRunById.mockReset();
    continueMock.readDurableHitlGateForContinue.mockReset().mockResolvedValue(null);
    continueMock.readCurrentDurableHitlGate.mockReset().mockImplementation(currentIsTheAnsweredGate);
  });

  it("answering the step the run waits at is accepted", async () => {
    await approveReviewTaskInternal(`wayflow-${STEP_B}`, "actor-1", { approved: true, userResponse: "go" });
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(wayflowText()).toBe("go");
  });

  it("answering the older step whose row was written is refused", async () => {
    await expect(
      approveReviewTaskInternal(`wayflow-${STEP_A}`, "actor-1", { approved: true, userResponse: "go" }),
    ).rejects.toMatchObject({
      name: "GateNotPendingError",
      message: "WayFlow approval rejected: gate task-a on run run-r1 is no longer the pause the run waits at",
    });
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(sendTaskMock).not.toHaveBeenCalled();
  });

  it("an older display-only row does not refuse the step the run waits at", async () => {
    continueMock.readCurrentDurableHitlGate.mockResolvedValue({
      ...rowOfA,
      xRenderer: "@cinatra-ai/agent-builder:artifact-review-redirect",
    });
    await approveReviewTaskInternal(`wayflow-${STEP_B}`, "actor-1", { approved: true, userResponse: "go" });
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
  });
});

// A ONE-VALUE ANSWER WITH NO RESUME TEXT OF ITS OWN IS NOT AN APPROVAL. A text,
// a number, a boolean or a list that reaches a WayFlow gate bare, or under the
// field it names (the setup-loop shape), is sent as the plain form sends it: the
// run receives what was written. The approval marker stays for a submission that
// carries no answer: no values, an approval flag or note, or a structured record.
describe("a one-value answer without a resume text reaches the run", () => {
  const TASK = "wayflow-task-r1";

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    continueMock.readDurableHitlGateForContinue.mockReset().mockResolvedValue(null);
  });

  const KEPT: Array<{ label: string; values: unknown; fieldName?: string; text: string; recorded: unknown }> = [
    { label: "a named text", values: { answer: "Ship it." }, fieldName: "answer", text: "Ship it.", recorded: { answer: "Ship it." } },
    { label: "a named number", values: { answer: 42 }, fieldName: "answer", text: "42", recorded: { answer: 42 } },
    { label: "a named boolean", values: { answer: false }, fieldName: "answer", text: "false", recorded: { answer: false } },
    { label: "a named list", values: { answer: ["a", "b"] }, fieldName: "answer", text: '["a","b"]', recorded: { answer: ["a", "b"] } },
    { label: "a bare text", values: "Ship it.", text: "Ship it.", recorded: { "hitl-field": "Ship it." } },
    { label: "a bare number", values: 0, text: "0", recorded: { "hitl-field": 0 } },
  ];

  for (const c of KEPT) {
    // red-first-expect: expected '[Approved by operator]' to be
    it(`${c.label} is the resume text and is recorded under its field`, async () => {
      await approveReviewTaskInternal(TASK, "actor-1", c.values, c.fieldName);
      expect(sendTaskMock).toHaveBeenCalledTimes(1);
      expect(wayflowText()).toBe(c.text);
      const written = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
      expect(written?.submittedValues).toEqual(c.recorded);
    });
  }

  it("a named blank answer sends the marker and is kept as a blank answer", async () => {
    await approveReviewTaskInternal(TASK, "actor-1", { answer: null }, "answer");
    expect(wayflowText()).toBe("[Approved by operator]");
    const written = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
    expect(written?.submittedValues).toEqual({ answer: null });
  });

  it("a submission that carries no answer keeps the approval marker", async () => {
    for (const values of [
      undefined,
      { approved: true, approvedAt: "2026-11-25T00:00:00.000Z" },
      { note: "Go ahead." },
      { answer: "Ship it.", other: "x" },
    ]) {
      sendTaskMock.mockClear();
      await approveReviewTaskInternal(TASK, "actor-1", values, values && "answer" in values ? "answer" : undefined);
      expect(wayflowText(), JSON.stringify(values)).toBe("[Approved by operator]");
    }
  });

  it("an approval note keeps its own text", async () => {
    await approveReviewTaskInternal(TASK, "actor-1", { approvalNote: " Looks good. " });
    expect(wayflowText()).toBe("Looks good.");
  });
});
