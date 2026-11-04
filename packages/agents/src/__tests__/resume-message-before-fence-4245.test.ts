/**
 * cinatra#4245 change B — the resume message is complete before the fence.
 *
 * Past the fence a failure counts as possibly sent: the lease is settled, not given
 * back, and the run stays `running`. So nothing that can fail before the send may
 * sit between the fence and the call. The message id is drawn from `randomUUID()`;
 * when that draw fails, nothing can have been sent, and the pause must be given
 * back with no fence, no prompt row and no send. Read here on both resume roads
 * that draw an id (the MCP resume and the review page's Continue); the delivery
 * worker's id is fixed per gate.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/resume-message-before-fence-4245.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { RunTransitionError } from "../run-status";

const uuid = vi.hoisted(() => ({ down: false }));
vi.mock("node:crypto", async (orig) => {
  const actual = await orig<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      if (uuid.down) throw new Error("no entropy for the message id");
      return actual.randomUUID(...args);
    },
  };
});

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
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await (storeMock.writeHitlPrompt as unknown as (value: unknown) => Promise<void>)(input);
    return "captured-prompt";
  },
  readDurableHitlGateForContinue: async () => null,
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
// No rows: the install-scope guard reads nothing and decides nothing.
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
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";
import { resumeWayflowUnderPauseClaim } from "../run-resume-under-claim";
import * as claimModule from "../run-pause-claim";

const RUN = {
  id: "run-msg-4245",
  templateId: "tpl-msg-4245",
  orgId: "org-1",
  runBy: "reader-msg",
  authPolicy: null,
  a2aContextId: "ctx-msg-4245",
  a2aTaskId: "task-msg-4245",
  pauseGeneration: 1,
};
const liveRun = () => ({ ...RUN, status: row.status });
const fenceCalls = () => storeMock.transitionRunStatus.mock.calls.filter((c) => c[1] === "pending_approval" && c[2] === "running");

// The claim writers as the module under test sees them (the always-winning fake).
const pauseClaimFake = claimModule as unknown as Record<"releasePauseClaim" | "settlePauseSend", ReturnType<typeof vi.fn>>;

function arrange() {
  uuid.down = false;
  row.status = "pending_approval";
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
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
  sendTask.mockImplementation(async () => ({ id: "task-next", contextId: RUN.a2aContextId, status: { state: "input-required" } }));
}

// Continue reaches its collaborators through DYNAMIC imports: one answer is driven
// through the whole road first, so the module registry is warm before any reading.
beforeAll(async () => {
  arrange();
  await approveReviewTaskInternal("wayflow-gate-msg-4245", RUN.runBy).catch(() => undefined);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  arrange();
});

describe("cinatra#4245 — a failed message id is a failure before the fence", () => {
  it("the MCP resume: the pause is given back, with no fence, no prompt row and no send", async () => {
    uuid.down = true;
    await expect(
      resumeWayflowUnderPauseClaim({
        run: { ...RUN, status: "pending_approval" } as never,
        client: { sendTask } as never,
        resumeText: "go on",
        prompt: { agentId: "@cinatra-ai/blog-idea-generator", message: "go on", submittedValues: null },
        authority: { orgId: RUN.orgId } as never,
        readRun: async () => liveRun(),
      }),
    ).rejects.toThrow("no entropy for the message id");
    expect(fenceCalls()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.settlePauseSend).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("the MCP resume (guard): with a working id it fences, records the answer, sends once and settles", async () => {
    const answer = await resumeWayflowUnderPauseClaim({
      run: { ...RUN, status: "pending_approval" } as never,
      client: { sendTask } as never,
      resumeText: "go on",
      prompt: { agentId: "@cinatra-ai/blog-idea-generator", message: "go on", submittedValues: null },
      authority: { orgId: RUN.orgId } as never,
      readRun: async () => liveRun(),
    });
    expect(answer.error).toBeUndefined();
    expect(fenceCalls()).toHaveLength(1);
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.releasePauseClaim).not.toHaveBeenCalled();
  });

  it("Continue: the pause is given back, with no fence, no prompt row and no send", async () => {
    uuid.down = true;
    await expect(approveReviewTaskInternal("wayflow-gate-msg-4245", RUN.runBy)).rejects.toThrow("no entropy for the message id");
    expect(fenceCalls()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.settlePauseSend).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(row.status).toBe("pending_approval");
  });

  it("Continue (guard): with a working id it fences, records the answer, sends once and settles", async () => {
    await approveReviewTaskInternal("wayflow-gate-msg-4245", RUN.runBy);
    expect(fenceCalls()).toHaveLength(1);
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.releasePauseClaim).not.toHaveBeenCalled();
  });
});
