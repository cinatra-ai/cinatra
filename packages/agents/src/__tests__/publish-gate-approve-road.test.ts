// cinatra#4150 (A5): the generic approve road refuses a run held at a publish decision.
// A run waiting at a publish gate is resumed only by that decision; the generic
// `wayflow-` approve reads the hold AFTER its claim (so a decision parked before the
// claim is seen), then puts the claim back, records nothing and sends nothing into the
// held context. The harness is the one of review-gate-decided-once-3423.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunTransitionError } from "../run-status";

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
  transitionRunStatus: vi.fn(),
}));
vi.mock("../store", () => storeMock);
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await (storeMock.writeHitlPrompt as unknown as (value: unknown) => Promise<void>)(input);
    return "captured-prompt";
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

const decisions = vi.hoisted(() => ({
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: decisions.readLatestDecisionForRun,
}));

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
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";

const RUN = {
  id: "run-4150",
  templateId: "tpl-4150",
  orgId: "org-1",
  runBy: "reader-a",
  authPolicy: null,
  a2aContextId: "ctx-4150",
  a2aTaskId: "task-4150",
};

beforeEach(() => {
  vi.clearAllMocks();
  row.status = "pending_approval";
  storeMock.readAgentRunByTaskId.mockImplementation(async () => ({ ...RUN, status: row.status }));
  storeMock.readAgentRunById.mockImplementation(async () => ({ ...RUN, status: row.status }));
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-4150",
    packageName: "@cinatra-ai/blog-idea-generator",
    sourceType: "internal",
    agentAuthPolicy: null,
  });
  storeMock.transitionRunStatus.mockImplementation(async (runId: string, from: string, to: string) => {
    if (row.status !== from) {
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
    }
    row.status = to;
  });
  sendTask.mockResolvedValue({ id: "task-next", contextId: "ctx-4150", status: { state: "input-required" } });
  decisions.readLatestDecisionForRun.mockResolvedValue(null);
});

const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

describe("the generic approve road and a publish decision", () => {
  it.each(["parked", "declined", "expired", "run_ended"])(
    "a run whose newest decision is %s is refused with publish_decision_required, and the claim is put back",
    async (status) => {
      decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: RUN.id, status });
      await expect(approveReviewTaskInternal("wayflow-task-4150", "reader-a")).rejects.toMatchObject({
        code: "publish_decision_required",
      });
      expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith(RUN.id);
      expect(sendTask).not.toHaveBeenCalled();
      expect(moves()).toEqual([[RUN.id, "pending_approval", "running"], [RUN.id, "running", "pending_approval"]]);
      expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
      expect(handleWayflowTaskState).not.toHaveBeenCalled();
      expect(row.status).toBe("pending_approval");
    },
  );

  it("an unreadable decision record refuses too, and the claim is put back", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down"));
    await expect(approveReviewTaskInternal("wayflow-task-4150", "reader-a")).rejects.toThrow("db down");
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("the hold is read after the claim (pre-review 2 finding 3): a decision parked before the claim is seen", async () => {
    // Another resume parks a publish decision between this road's read of the run and its claim.
    storeMock.transitionRunStatus.mockImplementationOnce(async (_runId: string, from: string, to: string) => {
      decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: RUN.id, status: "parked" });
      if (row.status !== from) throw new RunTransitionError({ code: "stale_from_status", runId: RUN.id, from: from as never, to: to as never });
      row.status = to;
    });
    await expect(approveReviewTaskInternal("wayflow-task-4150", "reader-a")).rejects.toMatchObject({
      code: "publish_decision_required",
    });
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
    expect(storeMock.transitionRunStatus.mock.invocationCallOrder[0]!).toBeLessThan(
      decisions.readLatestDecisionForRun.mock.invocationCallOrder[0]!,
    );
  });

  it("a run with no decision, or a released one, is answered as before", async () => {
    await approveReviewTaskInternal("wayflow-task-4150", "reader-a");
    expect(sendTask).toHaveBeenCalledTimes(1);
    row.status = "pending_approval";
    sendTask.mockClear();
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: RUN.id, status: "released" });
    await approveReviewTaskInternal("wayflow-task-4150", "reader-a");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });
});
