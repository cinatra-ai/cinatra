/**
 * cinatra#3471: A RETIRED STEP IS ANSWERED BY NOTHING, ON EVERY SERVER ROAD.
 *
 * A step parked under a tombstoned renderer id (`isRetiredHitlStep`, the same
 * predicate the pages ask) is refused with the fixed text before the pause is
 * claimed: nothing is recorded or sent. Pinned on the review task action
 * (`approveReviewTaskInternal`) and on the resume under claim that
 * `agent_run_resume` (mcp/handlers.ts) takes. A step with no durable row is
 * answered as before.
 *
 * Harness mirrors approve-resume-envelope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pauseClaimFake } from "./pause-claim-test-fake";

vi.mock("server-only", () => ({}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../db", () => ({
  db: { update: vi.fn() },
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  writeHitlPrompt: vi.fn(async (_input: unknown) => undefined),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const durableRead = vi.hoisted(() => vi.fn(async (_runId: string, _reviewTaskId: string): Promise<unknown> => null));
vi.mock("../agent-run-hitl-prompts", () => ({
  readDurableHitlGateForContinue: durableRead,
  captureHitlPromptForContinue: async (input: never) => {
    await storeMock.writeHitlPrompt(input);
    return "captured-prompt";
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));

const sendTaskMock = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({ id: "task-r1", status: { state: "completed" }, contextId: "ctx-r1" })),
);
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskMock })),
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: vi.fn(async () => {}),
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { approveReviewTaskInternal } from "../review-task-actions";
import { resumeWayflowUnderPauseClaim } from "../run-resume-under-claim";

const REFUSAL = "This step was retired and can no longer be answered; nothing was sent. Start a new run.";
const TOMBSTONED = ["@cinatra/email-reviewer-agent:output", "@cinatra/email-reviewer-agent:ai-review-panel", "ai-review-panel"];
const TASK = "wayflow-task-r1";
const parkAt = (xRenderer: string) =>
  durableRead.mockResolvedValue({
    runId: "run-r1", reviewTaskId: TASK, xRenderer,
    inputSchema: { type: "object" }, values: {}, materializedAt: "2026-11-26T00:00:00.000Z",
  });

beforeEach(() => {
  vi.clearAllMocks();
  durableRead.mockReset().mockResolvedValue(null);
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-r1", templateId: "tpl-int", status: "pending_approval", a2aContextId: "ctx-r1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-int", packageName: "@cinatra-ai/email-outreach-agent", sourceType: "internal",
  });
});

describe("the review task action and a retired step", () => {
  const answer = () => approveReviewTaskInternal(TASK, "actor-1", { approved: true, userResponse: "go" });

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("refuses every tombstoned id with the fixed text and sends nothing", async () => {
    for (const id of TOMBSTONED) {
      parkAt(id);
      await expect(answer(), id).rejects.toThrow(REFUSAL);
    }
    expect(durableRead).toHaveBeenCalledWith("run-r1", TASK);
    expect(sendTaskMock).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("answers an ordinary step and a step with no row as before", async () => {
    parkAt("@cinatra-ai/agent-builder:schema-field-fallback");
    await answer();
    durableRead.mockResolvedValue(null);
    await answer();
    expect(sendTaskMock).toHaveBeenCalledTimes(2);
  });
});

describe("the resume under claim (agent_run_resume) and a retired step", () => {
  const resume = () =>
    resumeWayflowUnderPauseClaim({
      run: { id: "run-r1", orgId: "org-1", pauseGeneration: 1, a2aTaskId: "task-r1", a2aContextId: "ctx-r1" } as never,
      client: { sendTask: sendTaskMock as never },
      resumeText: "go",
      prompt: { agentId: "@cinatra-ai/email-outreach-agent", message: "go", submittedValues: null },
      authority: {} as never,
      readRun: async () => ({ status: "pending_approval" }),
    });

  // red-first-expect: @cinatra/email-reviewer-agent:output: expected undefined to be 'This step was retired and can no long
  it("refuses every tombstoned id with the fixed text before the claim and sends nothing", async () => {
    for (const id of TOMBSTONED) {
      parkAt(id);
      const result = await resume().catch((thrown: unknown) => ({ thrown }));
      expect((result as { error?: string }).error, id).toBe(REFUSAL);
    }
    expect(durableRead).toHaveBeenCalledWith("run-r1", TASK);
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(sendTaskMock).not.toHaveBeenCalled();
  });

  it("claims the pause for a step with no row, as before", async () => {
    await resume().catch(() => undefined);
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
  });
});
