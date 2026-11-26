/**
 * cinatra#3471: A RETIRED STEP IS REFUSED ON THE SETUP ROAD TOO.
 *
 * A `setup-<runId>` gate is parked by the setup loop (execution.ts) under the
 * renderer id the agent's own field schema names (`x-renderer`), and its durable
 * row (keyed `setup-<runId>`) stores that id. When the id is tombstoned
 * (`isRetiredHitlStep`, the predicate the pages and the WayFlow road ask), the
 * answer is refused with the fixed text BEFORE the inputParams merge, the status
 * flip and the re-enqueue, on both entries: the review task action
 * (`approveReviewTaskInternal`) and the MCP setup resume (`agent_run_resume` on a
 * run with no a2aTaskId), which calls that action. A setup step with no durable
 * row, or under an ordinary id, is answered as before.
 *
 * Harness: handlers-auth-policy.test.ts (the MCP entry) plus the guarded-write
 * fakes of approve-setup-field.test.ts (the writes this refusal must prevent).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));

const dbWrites: Array<{ set: Record<string, unknown> }> = [];
const kernelAnswers = vi.hoisted(() => ({
  organization: { archivedAt: null as string | null, archiveEpoch: 0 },
  leaseHeld: false,
}));
// The run's live pause generation; `null` = not modelled (the CAS always wins).
const livePause = vi.hoisted(() => ({ generation: null as number | null }));
const dbMock = vi.hoisted(() => {
  const state = { updateCalls: 0 };
  const update = () => {
    state.updateCalls += 1;
    return {
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            // cinatra#3471: a CAS bound to a pause generation the run has left matches 0 rows.
            if (livePause.generation !== null) {
              const { PgDialect } = await import("drizzle-orm/pg-core");
              const q = new PgDialect().sqlToQuery(cond as never);
              const m = /"pause_generation" = \$(\d+)/.exec(q.sql);
              if (m && q.params[Number(m[1]) - 1] !== livePause.generation) return [];
            }
            dbWrites.push({ set });
            return [{ id: "row" }];
          },
        }),
      }),
    };
  };
  return { state, baseTx: { update, execute: async () => ({ rows: [] }) } };
});
vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const tx = wrapTxWithOrgWriteKernel(dbMock.baseTx, kernelAnswers);
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
  };
});
const bgJobs = vi.hoisted(() => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("@/lib/background-jobs", () => bgJobs);

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  writeHitlPrompt: vi.fn(async () => undefined),
  transitionRunStatus: vi.fn(async () => undefined),
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
  resolveDefaultOrgId: vi.fn(async () => "org-default"),
}));
vi.mock("../store", () => storeMock);
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));

const durableRead = vi.hoisted(() => vi.fn(async (_runId: string, _reviewTaskId: string): Promise<unknown> => null));
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  ...(await orig<typeof import("../agent-run-hitl-prompts")>()),
  readDurableHitlGateForContinue: durableRead,
}));

import { approveReviewTaskInternal } from "../review-task-actions";

const REFUSAL = "This step was retired and can no longer be answered; nothing was sent. Start a new run.";
const TOMBSTONED = ["@cinatra/email-reviewer-agent:output", "@cinatra/email-reviewer-agent:ai-review-panel", "ai-review-panel"];
const RUN_ID = "run-s1";
const SETUP_ID = `setup-${RUN_ID}`;
const ACTOR = { actorType: "human" as const, source: "ui" as const, userId: "u1" };

const parkAt = (xRenderer: string) =>
  durableRead.mockResolvedValue({
    runId: RUN_ID, reviewTaskId: SETUP_ID, xRenderer, fieldName: "name",
    inputSchema: { type: "string" }, values: {}, materializedAt: "2026-11-26T00:00:00.000Z",
  });
const expectNothingMutated = () => {
  expect(dbMock.state.updateCalls).toBe(0);
  expect(dbWrites).toHaveLength(0);
  expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  dbWrites.length = 0;
  dbMock.state.updateCalls = 0;
  livePause.generation = null;
  durableRead.mockReset().mockResolvedValue(null);
  storeMock.readAgentRunById.mockResolvedValue({
    id: RUN_ID, templateId: "tpl-s1", orgId: "org-default", runBy: "u1",
    status: "pending_approval", inputParams: {}, a2aTaskId: null, a2aContextId: null,
  });
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tpl-s1", sourceType: "internal", packageName: "@cinatra/agent" });
});

describe("the review task action's setup branch and a retired step", () => {
  const answer = () => approveReviewTaskInternal(SETUP_ID, "actor-1", { name: "Alice" }, "name");

  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("refuses every tombstoned id with the fixed text and mutates nothing", async () => {
    for (const id of TOMBSTONED) {
      parkAt(id);
      await expect(answer(), id).rejects.toThrow(REFUSAL);
    }
    expect(durableRead).toHaveBeenCalledWith(RUN_ID, SETUP_ID);
    expectNothingMutated();
  });

  it("answers an ordinary setup step as before", async () => {
    parkAt("@cinatra-ai/agent-builder:schema-field-fallback");
    await answer();
    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0].set.status).toBe("queued");
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("answers a setup step with no durable row as before", async () => {
    await answer();
    expect(dbWrites).toHaveLength(1);
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});

describe("the MCP setup resume (agent_run_resume) and a retired step", () => {
  const resume = async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    return createAgentBuilderPrimitiveHandlers().agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: RUN_ID, userResponse: JSON.stringify({ name: "Alice" }) },
      actor: ACTOR,
      mode: "deterministic",
    });
  };

  // red-first-expect: @cinatra/email-reviewer-agent:output: expected { runId: 'run-s1', …(2) } to deeply equal { error: StringContaining
  it("refuses every tombstoned id with the fixed text and mutates nothing", async () => {
    for (const id of TOMBSTONED) {
      parkAt(id);
      expect(await resume(), id).toEqual({ error: expect.stringContaining(REFUSAL) });
    }
    expectNothingMutated();
  });

  it("answers an ordinary setup step as before", async () => {
    parkAt("@cinatra-ai/agent-builder:schema-field-fallback");
    expect(await resume()).toMatchObject({ runId: RUN_ID, status: "resuming" });
    expect(dbWrites).toHaveLength(1);
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});

// cinatra#3471 (convergence finding 2): every setup field reuses `setup-<runId>`.
// Request A reads the run (generation 4) and checks the parked gate (field 1,
// ordinary); before A writes, another request answers field 1 and the run
// re-parks (generation 5) on field 2 under a retired id. A's write is bound to
// the park it checked, so it is refused: nothing merged, nothing queued.
describe("a stale setup request and a run re-parked on a retired step", () => {
  // red-first-expect: promise resolved "undefined" instead of rejecting
  it("refuses the stale write and mutates nothing", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: RUN_ID, templateId: "tpl-s1", orgId: "org-default", runBy: "u1",
      status: "pending_approval", inputParams: {}, a2aTaskId: null, a2aContextId: null, pauseGeneration: 4,
    });
    livePause.generation = 4;
    durableRead.mockImplementationOnce(async () => {
      // A's check sees field 1 (ordinary); the run then re-parks on retired field 2.
      livePause.generation = 5;
      durableRead.mockResolvedValue({
        runId: RUN_ID, reviewTaskId: SETUP_ID, xRenderer: "ai-review-panel", fieldName: "second",
        inputSchema: { type: "string" }, values: {}, materializedAt: "2026-11-26T00:00:01.000Z",
      });
      return {
        runId: RUN_ID, reviewTaskId: SETUP_ID, xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
        fieldName: "name", inputSchema: { type: "string" }, values: {}, materializedAt: "2026-11-26T00:00:00.000Z",
      };
    });
    await expect(approveReviewTaskInternal(SETUP_ID, "actor-1", { name: "Alice" }, "name")).rejects.toMatchObject({ code: "stale_from_status" });
    expect(dbWrites).toHaveLength(0);
    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("answers a request whose park is still current", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: RUN_ID, templateId: "tpl-s1", orgId: "org-default", runBy: "u1",
      status: "pending_approval", inputParams: {}, a2aTaskId: null, a2aContextId: null, pauseGeneration: 4,
    });
    livePause.generation = 4;
    parkAt("@cinatra-ai/agent-builder:schema-field-fallback");
    await approveReviewTaskInternal(SETUP_ID, "actor-1", { name: "Alice" }, "name");
    expect(dbWrites).toHaveLength(1);
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});
