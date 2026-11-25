/**
 * cinatra#3562 — A MID-RUN LIST STEP IS ANSWERED WITH A LIST, on the server too.
 *
 * A list step's pick reaches the answer road lifted into the resume text
 * (`liftRendererApprovalNote`: `{type: "list", listId, …}`, or `listIds` for
 * several picks). The hosts withhold their Continue while nothing is picked;
 * the server refuses as well, before the pause is claimed, so nothing is
 * recorded and nothing is sent:
 *   - a list answer that names no list, on any step;
 *   - an answer with no list answer at all, on a step the durable gate row
 *     names as a list step.
 * An answer that names a list goes on as before.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-step-answer-names-a-list-3562.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));
const gate = vi.hoisted(() => ({ xRenderer: null as string | null }));
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
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async () => "captured-prompt",
  // The durable gate row of the answered step, when the test names its renderer.
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) =>
    gate.xRenderer === null
      ? null
      : {
          runId,
          reviewTaskId,
          xRenderer: gate.xRenderer,
          inputSchema: { type: "object" },
          values: {},
          materializedAt: new Date(0).toISOString(),
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
  // The answer's own bookkeeping in Redis, which this suite does not read.
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberAnsweredGateSubmission: vi.fn(async () => undefined),
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";
import * as claimModule from "../run-pause-claim";

const RUN = {
  id: "run-list-3562",
  templateId: "tpl-list-3562",
  orgId: "org-1",
  runBy: "reader-list",
  authPolicy: null,
  a2aContextId: "ctx-list-3562",
  a2aTaskId: "task-list-3562",
  pauseGeneration: 1,
};
const TASK = "wayflow-task-list-3562";
const LIST_STEP = "@cinatra-ai/list-curator-agent:list-picker";
const liveRun = () => ({ ...RUN, status: row.status });
const claim = claimModule as unknown as Record<"claimPause", ReturnType<typeof vi.fn>>;
const note = (answer: Record<string, unknown>) => ({ approvalNote: JSON.stringify(answer) });

function arrange() {
  row.status = "pending_approval";
  gate.xRenderer = LIST_STEP;
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
    packageName: "@cinatra-ai/list-curator-agent",
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

// The road reaches its collaborators through dynamic imports: one answer warms them.
beforeAll(async () => {
  arrange();
  await approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listId: "l-1" })).catch(() => undefined);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  arrange();
});

function expectRefusedBeforeTheClaim() {
  expect(claim.claimPause).not.toHaveBeenCalled();
  expect(sendTask).not.toHaveBeenCalled();
  expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
  expect(row.status).toBe("pending_approval");
}

describe("cinatra#3562 — the answer road refuses a list step answered without a list", () => {
  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("a lifted list answer with an empty listId is refused with its code, before the pause is claimed", async () => {
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listId: "", listName: "", memberCount: 0 })),
    ).rejects.toMatchObject({ code: "LIST_STEP_ANSWER_NAMES_NO_LIST" });
    expectRefusedBeforeTheClaim();
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("an untagged answer naming no list, and the several-list form with no usable id, are refused on a list step", async () => {
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, note({ listId: "", listName: "" })),
    ).rejects.toMatchObject({ code: "LIST_STEP_ANSWER_NAMES_NO_LIST" });
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listIds: ["", "  "], listNames: [] })),
    ).rejects.toMatchObject({ code: "LIST_STEP_ANSWER_NAMES_NO_LIST" });
    expectRefusedBeforeTheClaim();
  });

  it("a step of another kind is never judged as a list step, whatever its answer carries", async () => {
    gate.xRenderer = null;
    await approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listId: "" }));
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("an attachment-wrapped list answer that names no list is refused", async () => {
    await expect(
      approveReviewTaskInternal(TASK, RUN.runBy, {
        userResponse: JSON.stringify({ text: JSON.stringify({ type: "list", listId: " " }), attachments: [] }),
      }),
    ).rejects.toMatchObject({ code: "LIST_STEP_ANSWER_NAMES_NO_LIST" });
    expectRefusedBeforeTheClaim();
  });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("a list step answered with no list answer at all (a bare approve, a free text) is refused", async () => {
    await expect(approveReviewTaskInternal(TASK, RUN.runBy)).rejects.toMatchObject({
      code: "LIST_STEP_ANSWER_NAMES_NO_LIST",
    });
    await expect(approveReviewTaskInternal(TASK, RUN.runBy, { userResponse: "go on" })).rejects.toMatchObject({
      code: "LIST_STEP_ANSWER_NAMES_NO_LIST",
    });
    expectRefusedBeforeTheClaim();
  });

  it("a list answer that names a list goes on: claimed and sent once", async () => {
    await approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listId: "l-1", listName: "Q2 Targets" }));
    expect(claim.claimPause).toHaveBeenCalledTimes(1);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("an untagged answer that names a list goes on", async () => {
    await approveReviewTaskInternal(TASK, RUN.runBy, note({ listId: "l-1", listName: "Q2 Targets" }));
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("several picks that name a list go on", async () => {
    await approveReviewTaskInternal(TASK, RUN.runBy, note({ type: "list", listIds: ["l-1", "l-2"], listNames: ["A", "B"] }));
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a step with no durable list-step row, answered with a free text, goes on as before", async () => {
    gate.xRenderer = null;
    await approveReviewTaskInternal(TASK, RUN.runBy, { userResponse: "go on" });
    expect(sendTask).toHaveBeenCalledTimes(1);
  });
});
