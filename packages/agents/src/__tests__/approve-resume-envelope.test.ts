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
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await storeMock.writeHitlPrompt(input); return "captured-prompt";
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "", continueGateDigest: () => "",
}));

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: sendTaskMock,
  })),
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

// A gate whose renderer id no binding declares any more is drawn by the schema
// floor. END TO END from the answer a host builds for it (the floor's own
// payload, decided by the drawn entry, not by the original id) to the text
// WayFlow receives: the written note, not "[Approved by operator]".
describe("a gate the schema floor draws for an unclaimed id resumes with the written note", () => {
  const DROPPED_ID = "@cinatra-ai/some-retired-agent:old-screen";
  const SCHEMA = { type: "object", properties: { note: { type: "string", title: "Note" } } };

  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      priority: 1,
      condition: (_f, schema) => schema["x-renderer"] === SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      renderer: () => null,
      drawsOwnSubmit: true,
    });
  });

  function sentText(): string | undefined {
    const call = sendTaskMock.mock.calls[0]?.[0] as unknown as {
      message?: { parts?: Array<{ kind?: string; text?: string }> };
    };
    return call?.message?.parts?.[0]?.text;
  }

  // red-first-expect: resolveHitlGateRenderer is not a function
  it("the host's answer for the floor-drawn gate reaches WayFlow as the note", async () => {
    const entry = midRun.resolveHitlGateRenderer(
      "hitl",
      { ...SCHEMA, "x-renderer": DROPPED_ID },
      { connectedApps: [] },
    );
    const { payload, payloadFieldName } = gateSubmit.buildFieldGateAnswer({
      drawnByFloor: midRun.gateDrawnBySchemaFloor(DROPPED_ID, entry),
      reviewTaskId: "wayflow-task-r1",
      fieldName: undefined,
      next: { note: "Go ahead." },
      schema: SCHEMA,
    });
    expect(payloadFieldName).toBeUndefined();
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", payload as Record<string, unknown>);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toBe("Go ahead.");
  });

  it("the raw field answer (the setup-loop shape) would resume with the bare marker", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { note: "Go ahead." });
    expect(sentText()).toBe("[Approved by operator]");
  });
});
