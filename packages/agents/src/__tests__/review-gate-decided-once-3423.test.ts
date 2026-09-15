/**
 * ONE ANSWER PER GATE (cinatra#3423).
 *
 * Two people held the same pending review gate and answered it at the same
 * moment. Both answers were accepted: the WayFlow branch of
 * `approveReviewTaskInternal` READ `run.status`, found `pending_approval`, and
 * dispatched — and between that read and the dispatch the gate was still open to
 * everyone else, so both callers resumed the SAME paused conversation and the
 * run died with "WayFlow task failed" (the two runs the issue names, measured on
 * a real boot).
 *
 * What has to be true instead, in the issue's own words:
 *
 *   "The second answer to an already-decided gate is refused with the typed
 *    no-longer-pending outcome, and the run continues on the first answer (a
 *    test with two concurrent decisions on one gate, red first)."
 *
 * So this drives TWO CONCURRENT DECISIONS on ONE gate through the real helper,
 * against a status row that only one compare-and-swap can win, and pins all four
 * halves of that sentence: one winner, one typed refusal, one dispatch, one
 * recorded answer — and a run that goes on rather than failing.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/review-gate-decided-once-3423.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { GateNotPendingError, RunTransitionError } from "../run-status";

// The run row, as a tiny state machine: ONE conditional transition may win it.
// This is the whole fixture — the race is decided by the same rule Postgres
// decides it by (`UPDATE … WHERE status = <from>` matches one row or none).
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

// No rows: the install-scope guard on this road reads the run's scope ref
// straight off the database and returns without a decision when there is none,
// so the REAL guard runs here and authorizes nothing into existence.
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
}));

const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import { approveReviewTaskInternal } from "../review-task-actions";

const RUN = {
  id: "run-3423",
  templateId: "tpl-3423",
  orgId: "org-1",
  runBy: "reader-a",
  authPolicy: null,
  a2aContextId: "ctx-3423",
  a2aTaskId: "task-3423",
};

/** The run row as the two callers see it, with the live status. */
function liveRun() {
  return { ...RUN, status: row.status };
}

describe("approveReviewTaskInternal — two concurrent decisions on one gate", () => {
  // The helper reaches its collaborators through DYNAMIC imports (a documented
  // circular-dependency avoidance). One answer is driven through the whole road
  // first so the two callers below race the GATE and not the module registry.
  beforeAll(async () => {
    arrange();
    await answerTheGate().catch(() => undefined);
  });

  function arrange() {
    row.status = "pending_approval";
    storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
    storeMock.readAgentRunById.mockImplementation(async () => liveRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-3423",
      packageName: "@cinatra-ai/blog-idea-generator",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    storeMock.writeHitlPrompt.mockResolvedValue(undefined);
    // The conditional transition: it commits only while the row still carries
    // the `from` status, exactly like the org-scoped CAS in the database.
    storeMock.transitionRunStatus.mockImplementation(
      async (runId: string, from: string, to: string) => {
        if (row.status !== from) {
          throw new RunTransitionError({
            code: "stale_from_status",
            runId,
            from: from as never,
            to: to as never,
          });
        }
        row.status = to;
      },
    );
    sendTask.mockImplementation(async () => ({
      id: "task-next",
      contextId: "ctx-3423",
      status: { state: "input-required" },
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    arrange();
  });

  async function answerTheGate() {
    return approveReviewTaskInternal("wayflow-task-3423", "reader-a");
  }

  it("accepts the first answer and refuses the second with the TYPED no-longer-pending outcome", async () => {
    const [first, second] = await Promise.allSettled([answerTheGate(), answerTheGate()]);

    const settled = [first, second];
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused).toBeDefined();
    // TYPED, and typed is the whole point: the message does not survive the
    // Server Action boundary, `name` + `code` do.
    expect(refused.reason).toBeInstanceOf(GateNotPendingError);
    expect((refused.reason as GateNotPendingError).code).toBe("gate_not_pending");
    expect((refused.reason as GateNotPendingError).name).toBe("GateNotPendingError");
    // The loser reads the WINNER'S disposition back off the row.
    expect((refused.reason as GateNotPendingError).currentStatus).toBe("running");
  });

  it("resumes the paused conversation ONCE — the second answer dispatches nothing", async () => {
    await Promise.allSettled([answerTheGate(), answerTheGate()]);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("records ONE answer for the gate — the loser writes nothing", async () => {
    await Promise.allSettled([answerTheGate(), answerTheGate()]);
    expect(storeMock.writeHitlPrompt).toHaveBeenCalledTimes(1);
  });

  it("the run CONTINUES on the first answer, and is never failed by the race", async () => {
    await Promise.allSettled([answerTheGate(), answerTheGate()]);
    expect(handleWayflowTaskState).toHaveBeenCalledTimes(1);
    // The run really is running by the time the task comes back, and the handler
    // is told where it is rather than where it was.
    expect(handleWayflowTaskState).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-3423", fromStatus: "running" }),
    );
    // Nothing on this road moved the run to a terminal failure.
    for (const call of storeMock.transitionRunStatus.mock.calls) {
      expect(call[2]).not.toBe("failed");
    }
    expect(row.status).toBe("running");
  });

  it("a gate answered a second time LATER is refused the same way, not accepted", async () => {
    await answerTheGate();
    sendTask.mockClear();
    await expect(answerTheGate()).rejects.toBeInstanceOf(GateNotPendingError);
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("releases the claim when the answer never leaves, so the gate stays answerable", async () => {
    sendTask.mockRejectedValueOnce(new Error("boom"));
    // A dispatch failure is NOT released — WayFlow may already hold the message.
    await expect(answerTheGate()).rejects.toThrow("boom");
    expect(row.status).toBe("running");

    row.status = "pending_approval";
    const { mintResumeRunTokenMetadata } = await import("../wayflow-run-token-carrier");
    (mintResumeRunTokenMetadata as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no carrier"),
    );
    await expect(answerTheGate()).rejects.toThrow("no carrier");
    // Nothing was dispatched, so the gate is put back the way it was found.
    expect(row.status).toBe("pending_approval");
  });
});
