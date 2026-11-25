/**
 * cinatra#3470: THE SERVER ENFORCES A DECLARED CARD'S ANSWER.
 *
 * An answer to a step a bundled agent's declared card draws reaches the one
 * approval core. It is sent only when it holds exactly the card's fields, each
 * with text, beside the host's own keys; the carried keys are taken from the
 * step's STORED values, and the one rebuilt object is what is sent. Anything
 * else is refused before the fence: the pause is given back and nothing is
 * sent. A step whose gate row cannot be read, for an agent that declares a
 * card, is refused the same way.
 *
 * The card is the one the step PAUSED WITH, written into its gate row when the
 * pause was recorded (`withDeclaredScreenOfStep`). A build deployed while the
 * run waits, whose binding changes the card's fields or drops it, does not
 * change what the step is answered with. A row that stored no card (paused
 * before this was recorded) is answered as before, with no card rule.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/declared-card-answer-road-3470.test.ts
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RunTransitionError } from "../run-status";

const { PKG, ID, PLAIN_ID, SCREEN, SCREEN_V2, BINDINGS } = vi.hoisted(() => ({
  PKG: "@acme/card-agent",
  ID: "@acme/card-agent:brief",
  PLAIN_ID: "@acme/plain-agent:confirm",
  SCREEN: {
    layout: "card",
    sections: [
      { type: "fact", label: "Topic", key: "topic" },
      { type: "field", key: "angle", label: "Angle" },
    ],
    carry: ["topic"],
  },
  /** The same renderer in a newer build: its field is another one. */
  SCREEN_V2: {
    layout: "card",
    sections: [{ type: "field", key: "hook", label: "Hook" }],
  },
  /** The build's bindings, swapped in place by a case (a newer build deployed). */
  BINDINGS: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GENERATED_FIELD_RENDERER_BINDINGS: BINDINGS,
}));

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
  transitionRunStatus: vi.fn(),
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../store", () => storeMock);
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
const capture = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => "captured-prompt"));
// The step's gate row, as the park wrote it.
const gateRow = vi.hoisted(() => ({
  read: "row" as "row" | "missing" | "throws",
  xRenderer: "",
  inputSchema: {} as Record<string, unknown>,
  values: {} as Record<string, unknown>,
}));
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  declaredScreenDigest: (await orig<typeof import("../agent-run-hitl-prompts")>()).declaredScreenDigest,
  captureHitlPromptForContinue: capture,
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) => {
    if (gateRow.read === "throws") throw new Error("fixture gate store down");
    if (gateRow.read === "missing") return null;
    return {
      runId,
      reviewTaskId,
      xRenderer: gateRow.xRenderer,
      inputSchema: gateRow.inputSchema,
      values: gateRow.values,
      materializedAt: "2026-01-01T00:00:00.000Z",
    };
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
vi.mock("../db", () => {
  const query: Record<string, unknown> = {};
  query.from = () => query;
  query.where = () => query;
  query.limit = async () => [];
  return {
    db: { select: () => query },
    agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
  };
});
vi.mock("../resume-run-from-setup-approval", () => ({
  resumeRunFromSetupApproval: vi.fn(async () => undefined),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })),
}));
const sendTask = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: vi.fn(async () => {}),
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";
import * as claimModule from "../run-pause-claim";

const RUN = {
  id: "run-card-answer",
  templateId: "tpl-card-answer",
  orgId: "org-1",
  runBy: "reader-card",
  authPolicy: null,
  a2aContextId: "ctx-card-answer",
  a2aTaskId: "task-card-answer",
  pauseGeneration: 1,
};
const GATE = "wayflow-gate-card-answer";

/** Deploy a build whose card binding declares `screen`, or no binding for it (`null`). */
function deploy(screen: Record<string, unknown> | null): void {
  BINDINGS.splice(
    0,
    BINDINGS.length,
    ...(screen ? [{ id: ID, kind: "cta", priority: 90, midRunHitl: true, screen, declaredBy: PKG }] : []),
    { id: PLAIN_ID, kind: "cta", priority: 90, midRunHitl: true, declaredBy: "@acme/plain-agent" },
  );
}


/** The stored form of a card, as the pause records it: the card and the sha-256 of its canonical JSON. */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);
const storedCard = (screen: unknown) => ({
  "x-declared-screen": { screen, digest: `sha256:${createHash("sha256").update(canon(screen)).digest("hex")}` },
});

/** The pause is recorded with the card the build declared then (v1), or with none. */
function pause(xRenderer = ID): void {
  gateRow.xRenderer = xRenderer;
  gateRow.inputSchema = { type: "object", ...(xRenderer === ID ? storedCard(SCREEN) : {}) };
}
const STORED = { stepNumber: 2, topic: "Audit trails for agent runs" };
const liveRun = () => ({ ...RUN, status: row.status });
const fenceCalls = () =>
  storeMock.transitionRunStatus.mock.calls.filter((c) => c[1] === "pending_approval" && c[2] === "running");
const pauseClaimFake = claimModule as unknown as Record<"releasePauseClaim" | "settlePauseSend", ReturnType<typeof vi.fn>>;

/** Answer the gate with `values`: "sent", or the refusal's text. */
function answer(values: unknown): Promise<string> {
  return approveReviewTaskInternal(GATE, RUN.runBy, values).then(
    () => "sent",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

/** Nothing was sent, and the pause was given back. */
function expectRefusedAndGivenBack(): void {
  expect(sendTask).not.toHaveBeenCalled();
  expect(fenceCalls()).toEqual([]);
  expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
  expect(row.status).toBe("pending_approval");
}

/** The text the agent was sent. */
function sentText(): string {
  const message = (sendTask.mock.calls[0]![0] as { message: { parts: Array<{ text?: string }> } }).message;
  return message.parts.map((p) => p.text ?? "").join("");
}

function arrange(packageName = PKG) {
  row.status = "pending_approval";
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
    packageName,
    sourceType: "internal",
    agentAuthPolicy: null,
  });
  storeMock.transitionRunStatus.mockImplementation(async (runId: string, from: string, to: string) => {
    if (row.status !== from) {
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
    }
    row.status = to;
  });
  sendTask.mockImplementation(async () => ({ id: "task-next", contextId: RUN.a2aContextId, status: { state: "input-required" } }));
}

const ANSWER = { topic: "Audit trails for agent runs", angle: "Why runs need a record" };
const CARD_SEND = { ...ANSWER, userResponse: JSON.stringify(ANSWER), approved: true, approvedAt: "2026-01-01T00:00:00.000Z" };

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Continue reaches its collaborators through dynamic imports: one answer is
  // driven through the whole road first, so the module registry is warm.
  gateRow.values = STORED;
  deploy(SCREEN);
  pause();
  arrange();
  await approveReviewTaskInternal(GATE, RUN.runBy, CARD_SEND).catch(() => undefined);
}, 60_000);

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  gateRow.read = "row";
  gateRow.values = STORED;
  deploy(SCREEN);
  pause();
  arrange();
});

describe("an answer to a declared card's step is sent only as the card's whole answer (cinatra#3470)", () => {
  it("sends the card's answer, rebuilt with the carried key from the step's stored values", async () => {
    const forged = { ...CARD_SEND, topic: "Forged topic", userResponse: JSON.stringify({ ...ANSWER, topic: "Forged topic" }) };
    expect(await answer(forged)).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain(JSON.stringify(ANSWER));
    expect(sentText()).not.toContain("Forged topic");
  });

  it.each([
    ["a key the card does not declare", { ...CARD_SEND, extra: "x" }],
    ["a blank field", { ...CARD_SEND, angle: "   " }],
    ["a missing field", { approved: true, userResponse: "ok" }],
    ["a decline", { ...CARD_SEND, approved: false }],
    ["files sent with the answer", { ...CARD_SEND, userResponse: JSON.stringify({ text: "x", attachments: [] }) }],
    ["a generic approval", { approved: true }],
  ])("refuses %s before the fence and gives the pause back", async (_name, values) => {
    expect(await answer(values)).toContain("card asks for an answer");
    expectRefusedAndGivenBack();
  });

  it.each([
    ["the agent still declares the card", SCREEN],
    ["a later build removed the declaration", null],
  ])("refuses when the step's gate row read fails (%s), before the fence, and gives the pause back", async (_n, now) => {
    deploy(now);
    gateRow.read = "throws";
    expect(await answer({ approved: true })).toContain("screen could not be read");
    expectRefusedAndGivenBack();
  });

  it("a step with no gate row (the read found none) is answered with no card rule, as before", async () => {
    gateRow.read = "missing";
    expect(await answer({ approved: true, extra: "kept" })).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("leaves a step with no declared card as it was", async () => {
    pause(PLAIN_ID);
    expect(await answer({ approved: true, extra: "kept" })).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["changes the card's fields", SCREEN_V2],
    ["drops the card's binding", null],
  ])("a build deployed while the step waits that %s: the step is answered with the card it paused with", async (_n, next) => {
    deploy(next);
    // The newer build's field is refused: the step never asked for it.
    expect(await answer({ hook: "A newer field", approved: true })).toContain("card asks for an answer");
    expect(sendTask).not.toHaveBeenCalled();
    vi.clearAllMocks();
    arrange();
    // The card it paused with is sent, rebuilt from the step's stored values.
    expect(await answer(CARD_SEND)).toBe("sent");
    expect(sentText()).toContain(JSON.stringify(ANSWER));
  });

  it("records the step's stored schema with the answer, not the client's copy, so the replay draws the card it paused with", async () => {
    const pausedWith = gateRow.inputSchema;
    deploy(SCREEN_V2);
    await approveReviewTaskInternal(GATE, RUN.runBy, CARD_SEND, undefined, { type: "object", forged: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0].schemaSnapshot).toEqual(pausedWith);
  });

  it("a row that stored no card (paused before the card was recorded) is answered with no card rule, as before", async () => {
    gateRow.inputSchema = { type: "object" };
    expect(await answer({ approved: true, extra: "kept" })).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("refuses a step whose stored card does not match its digest", async () => {
    const stored = gateRow.inputSchema["x-declared-screen"] as Record<string, unknown>;
    gateRow.inputSchema = { ...gateRow.inputSchema, "x-declared-screen": { ...stored, digest: "sha256:0" } };
    expect(await answer(CARD_SEND)).toContain("screen could not be read");
    expectRefusedAndGivenBack();
  });
});
