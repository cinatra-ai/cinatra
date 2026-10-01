/**
 * THE LOG LINE IS NOT A FORMAT STRING (cinatra#3423, the CodeQL round on the
 * gate-decided-once change).
 *
 * The claim/release road this change added logs with the gate's identity in
 * hand: the run id, the gate's task id, the error that stopped the release. It
 * put them INSIDE the first argument of the console call — a template literal
 * built from the caller-provided review task id — and that argument is the
 * FORMAT STRING. A caller-provided value in it is read as formatting
 * instructions rather than as text (`js/tainted-format-string`, flagged high on
 * this very catch).
 *
 * What has to be true instead:
 *
 *   "every console call this pull request touched in the three action modules
 *    takes a constant first argument, with caller-derived values (run id, task
 *    id, the error) as separate structured arguments"
 *
 * So this drives the three roads of `approveReviewTaskInternal` that log — the
 * failed prompt write, the resumed conversation, and the release of a claim that
 * could not be given back — and pins the SHAPE of each: a constant first
 * argument, the ids in a structured argument beside it, and no caller-derived
 * value anywhere in a first argument.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/review-gate-console-shape-3423.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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

// No rows: the install-scope guard reads the run's scope ref straight off the
// database and returns without a decision when there is none, so the REAL guard
// runs here and authorizes nothing into existence.
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

/** The caller-provided gate id, and the run it hangs off. */
const REVIEW_TASK_ID = "wayflow-gate-shape-3423";
const TASK_ID = "gate-shape-3423";
const ACTOR_ID = "reader-shape";

const RUN = {
  id: "run-shape-3423",
  templateId: "tpl-shape-3423",
  orgId: "org-1",
  runBy: ACTOR_ID,
  authPolicy: null,
  a2aContextId: "ctx-shape-3423",
  a2aTaskId: "task-shape-3423",
};

/** The messages, as constants. A constant is the whole point. */
const PROMPT_WRITE_FAILED = "[approveReviewTaskInternal] writeHitlPrompt failed";
const WAYFLOW_RESUMED = "[approveReviewTaskInternal] wayflow-path resumed";
const CLAIM_NOT_RELEASED = "[approveReviewTaskInternal] could not release the gate claim";

function liveRun() {
  return { ...RUN, status: row.status };
}

describe("approveReviewTaskInternal — the console calls of the claim road are not format strings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  // The helper reaches its collaborators through DYNAMIC imports (a documented
  // circular-dependency avoidance), so one answer is driven through the whole
  // road before anything is measured — the module registry is warm and the
  // readings below are the road's own.
  beforeAll(async () => {
    arrange();
    await answerTheGate().catch(() => undefined);
  });

  function arrange() {
    row.status = "pending_approval";
    storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
    storeMock.readAgentRunById.mockImplementation(async () => liveRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: RUN.templateId,
      packageName: "@cinatra-ai/blog-idea-generator",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    storeMock.writeHitlPrompt.mockResolvedValue(undefined);
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
      contextId: RUN.a2aContextId,
      status: { state: "input-required" },
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    arrange();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  // The file leaves the console the way it found it: the package's full run has
  // other suites reading it.
  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  async function answerTheGate() {
    return approveReviewTaskInternal(REVIEW_TASK_ID, ACTOR_ID);
  }

  /**
   * Every first argument this road handed the console that carries a
   * caller-derived id — the taint the rule is about. It must always be empty.
   */
  function firstArgumentsCarryingAnId(): unknown[] {
    return [...warnSpy.mock.calls, ...logSpy.mock.calls]
      .map((call) => call[0])
      .filter(
        (first) =>
          typeof first === "string" &&
          (first.includes(RUN.id) || first.includes(TASK_ID) || first.includes(ACTOR_ID)),
      );
  }

  it("warns about a claim it could not release with a CONSTANT first argument and the ids beside it", async () => {
    // Nothing is on the wire yet (the carrier never minted), so the road tries to
    // give the gate back — and that release fails too. This is the catch the
    // format-string rule flagged.
    const releaseError = new Error("release refused");
    storeMock.transitionRunStatus.mockImplementation(
      async (runId: string, from: string, to: string) => {
        if (from === "running" && to === "pending_approval") throw releaseError;
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
    const { mintResumeRunTokenMetadata } = await import("../wayflow-run-token-carrier");
    (mintResumeRunTokenMetadata as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no carrier"),
    );

    await expect(answerTheGate()).rejects.toThrow("no carrier");

    expect(warnSpy).toHaveBeenCalledWith(
      CLAIM_NOT_RELEASED,
      { runId: RUN.id, taskId: TASK_ID },
      releaseError,
    );
    expect(firstArgumentsCarryingAnId()).toEqual([]);
  });

  it("warns about a failed prompt write with a CONSTANT first argument and the run id beside it", async () => {
    const writeError = new Error("prompt write refused");
    storeMock.writeHitlPrompt.mockRejectedValueOnce(writeError);

    await answerTheGate();

    expect(warnSpy).toHaveBeenCalledWith(PROMPT_WRITE_FAILED, { runId: RUN.id }, writeError);
    expect(firstArgumentsCarryingAnId()).toEqual([]);
  });

  it("logs the resumed conversation with a CONSTANT first argument and the reading beside it", async () => {
    await answerTheGate();

    expect(logSpy).toHaveBeenCalledWith(WAYFLOW_RESUMED, {
      runId: RUN.id,
      taskId: TASK_ID,
      actorId: ACTOR_ID,
      resultState: "input-required",
    });
    expect(firstArgumentsCarryingAnId()).toEqual([]);
  });

  it("never hands the console a first argument built from a caller-provided value", async () => {
    // The three roads together, measured in one reading: the rule is about the
    // FIRST argument, and none of them may carry an id in it.
    await answerTheGate();
    storeMock.writeHitlPrompt.mockRejectedValueOnce(new Error("prompt write refused"));
    row.status = "pending_approval";
    await answerTheGate();

    expect(warnSpy.mock.calls.length + logSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of [...warnSpy.mock.calls, ...logSpy.mock.calls]) {
      expect(typeof call[0]).toBe("string");
    }
    expect(firstArgumentsCarryingAnId()).toEqual([]);
  });
});
