/**
 * cinatra#3470: A DECLINE REACHES THE RUNNING AGENT AS A DECLINE.
 *
 * The mid-run Continue sends `approved: false` when the screen staged a
 * decline (a declared card's "Do not post"). What the agent reads is the text
 * of the WayFlow resume message (`sendTask.message.parts[0].text`), and a
 * structured answer reaches it as the JSON string of the answer object. Before
 * this fix a decline without a `userResponse` fell through to the
 * "[Approved by operator]" marker, so the agent read an approval.
 *
 * Asserted here on the wire itself (the A2A client is the only stub on that
 * road; the resume text is built by the real `approveReviewTaskInternal`):
 *   - a bare decline resumes with JSON whose `approved` is false, carried
 *     keys included, and never with the approval marker;
 *   - a decline with a renderer-written JSON `userResponse`, with an
 *     attachment envelope, with a plain-text `userResponse` and with a note;
 *   - the captured prompt and the answered-gate binding see the same answer;
 *   - an approval keeps every existing road byte for byte;
 *   - end to end from the Continue's own payload builders.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/decline-reaches-the-agent-3470.test.ts
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
const answeredMock = vi.fn(async (..._args: unknown[]) => {});
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
  rememberAnsweredGateSubmission: (...args: unknown[]) => answeredMock(...args),
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
import {
  applyAttachmentEnvelopeUserResponseOnly,
  continueApprovalFlag,
  withContextSelectorEnvelope,
} from "../hitl-gate-submit";

function setupRun(): void {
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-r1",
    templateId: "tpl-int",
    status: "pending_approval",
    a2aContextId: "ctx-r1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-int",
    packageName: "@acme-test/publish-agent",
    sourceType: "internal",
  });
}

/** The one text part the running agent receives. */
function wireText(): string {
  expect(sendTaskMock).toHaveBeenCalledTimes(1);
  const call = sendTaskMock.mock.calls[0]?.[0] as SendTaskInput;
  expect(call?.message?.parts).toHaveLength(1);
  expect(call?.message?.parts?.[0]?.kind).toBe("text");
  return call?.message?.parts?.[0]?.text ?? "";
}

const ATTACHMENT = {
  artifactId: "art-1",
  representationRevisionId: "ver-1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload" as const,
  filename: "report.pdf",
};

describe("a decline reaches the running agent as a decline (cinatra#3470)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites.length = 0;
    setupRun();
  });

  it("a bare decline resumes with JSON that says approved: false, never the approval marker", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      itemId: "item-1",
      approved: false,
      approvedAt: "2026-11-10T00:00:00.000Z",
    });
    const text = wireText();
    expect(text).not.toContain("Approved by operator");
    expect(JSON.parse(text)).toEqual({
      itemId: "item-1",
      approved: false,
      approvedAt: "2026-11-10T00:00:00.000Z",
    });
  });

  it("the captured prompt and the answered-gate binding record the same decline", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { approved: false });
    const text = wireText();
    expect(JSON.parse(text)).toEqual({ approved: false });
    const prompt = storeMock.writeHitlPrompt.mock.calls[0]?.[0] as { submittedValues?: unknown };
    expect(prompt?.submittedValues).toEqual({ approved: false });
    expect(answeredMock).toHaveBeenCalledWith("run-r1", expect.any(String), text);
  });

  it("a renderer-written JSON userResponse keeps its keys and gains approved: false", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: JSON.stringify({ itemId: "item-1", approved: true }),
      approved: false,
    });
    expect(JSON.parse(wireText())).toEqual({ itemId: "item-1", approved: false });
  });

  it("an attachment envelope keeps its attachments and its text says approved: false", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: JSON.stringify({ text: "[Approved by operator]", attachments: [ATTACHMENT] }),
      itemId: "item-1",
      approved: false,
    });
    const envelope = JSON.parse(wireText()) as { text: string; attachments: unknown };
    expect(envelope.attachments).toEqual([ATTACHMENT]);
    expect(JSON.parse(envelope.text)).toEqual({ itemId: "item-1", approved: false });
  });

  it("a plain-text userResponse rides along under its own name", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      userResponse: "not now",
      approved: false,
    });
    expect(JSON.parse(wireText())).toEqual({ userResponse: "not now", approved: false });
  });

  it("a note does not turn a decline back into plain text", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", {
      approvalNote: "wrong account",
      approved: false,
    });
    expect(JSON.parse(wireText())).toEqual({ approvalNote: "wrong account", approved: false });
  });

  it("an approval keeps every existing road byte for byte", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { approved: true, approvedAt: "t" });
    expect(wireText()).toBe("[Approved by operator]");
    sendTaskMock.mockClear();
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { approvalNote: " ok ", approved: true });
    expect(wireText()).toBe("ok");
    sendTaskMock.mockClear();
    const structured = JSON.stringify({ itemId: "item-1", approved: true });
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { userResponse: structured, approved: true });
    expect(wireText()).toBe(structured);
    sendTaskMock.mockClear();
    // Only a boolean false is a decline.
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", { approved: "false" });
    expect(wireText()).toBe("[Approved by operator]");
  });

  it("end to end from the Continue's own payload: a staged decline reaches the agent as one", async () => {
    // The payload the HITL screen card's Continue builds from a declared
    // card's staged decline, with the card's own builders.
    const staged = { itemId: "item-1", revisionId: "rev-1", approved: false };
    let payload: Record<string, unknown> = {
      ...staged,
      approved: continueApprovalFlag(staged),
      approvedAt: "2026-11-10T00:00:00.000Z",
    };
    payload = applyAttachmentEnvelopeUserResponseOnly(payload, []);
    payload = withContextSelectorEnvelope("@acme-test/publish-agent:confirm", {}, payload);
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", payload);
    expect(JSON.parse(wireText())).toEqual({
      itemId: "item-1",
      revisionId: "rev-1",
      approved: false,
      approvedAt: "2026-11-10T00:00:00.000Z",
    });
  });
});
