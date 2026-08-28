import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cinatra#3007 — the operator's approval is a DIRECT resume caller: it drives
 * the same terminal handler the execution worker drives, and it owns no job it
 * could re-deliver. So when the hold cannot be recorded, the terminal write
 * still owed must already be on its own delivery by the time the sentinel
 * reaches this caller — otherwise the run sits non-terminal with nothing able to
 * land its verdict.
 */

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
  setAgentRunTokenHash: vi.fn(async () => {}),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const holdSpy = vi.hoisted(() =>
  vi.fn(async () => ({ held: true, reason: "hold-unpersisted" }) as {
    held: boolean;
    reason: string;
  }),
);
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: holdSpy,
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));

const enqueueSpy = vi.hoisted(() => vi.fn(async () => "queued"));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: enqueueSpy,
  BACKGROUND_JOB_NAMES: {
    AGENT_BUILDER_EXECUTION: "agent-builder-execution",
    UNBOUND_OUTPUT_DERIVE: "unbound-output-derive",
  },
}));

const { publishAgUiEventSpy, materializeSpy } = vi.hoisted(() => ({
  publishAgUiEventSpy: vi.fn(async () => undefined),
  materializeSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
    readLatestAgUiInterrupt: vi.fn(async () => null),
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class {
      onInterrupt = vi.fn();
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: materializeSpy,
}));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({})),
}));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

const sendTaskSpy = vi.hoisted(() => vi.fn(async (_req: unknown) => ({}) as unknown));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
    resolveRunIdByWayflowTaskId: vi.fn(async () => null),
    resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    rememberAnsweredGateSubmission: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});

import { approveReviewTaskInternal } from "../review-task-actions";
import {
  recoverProducedReviewHold,
  ProducedReviewHoldUnpersistedError,
  PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES,
  PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS,
  PRODUCED_REVIEW_RECOVERY_JOB_PREFIX,
  CINATRA_ENDNODE_OUTPUTS_SENTINEL,
} from "../execution";

const AUTHORITY = { orgId: "org-1", can: () => true };

function pausedRun() {
  return {
    id: "run-1",
    templateId: "tmpl-1",
    status: "pending_approval",
    a2aTaskId: "task-1",
    a2aContextId: "ctx-1",
    orgId: "org-1",
    runBy: "user-a",
    authPolicy: null,
    packageVersion: "1.0.0",
    inputParams: {},
    createdAt: new Date("2026-01-01"),
  };
}

function completedTask() {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "here is the draft" }] },
      {
        role: "agent",
        parts: [
          {
            kind: "data",
            data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: { title: "T", content: "C" } },
          },
        ],
      },
    ],
  };
}

function deliveredRecovery() {
  return enqueueSpy.mock.calls.find(
    (c) => (c as unknown[])[0] === "agent-builder-execution",
  ) as unknown as [string, Record<string, unknown>, Record<string, unknown>] | undefined;
}

describe("cinatra#3007 — an unrecordable hold inside the operator's approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
    });
    sendTaskSpy.mockResolvedValue(completedTask());
    materializeSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "hold-unpersisted" });
  });

  it("puts the withheld terminal write on its delivery, and writes no terminal status", async () => {
    const err = (await approveReviewTaskInternal("wayflow-task-1", "user-a").catch(
      (e: unknown) => e,
    )) as ProducedReviewHoldUnpersistedError;

    expect(err).toBeInstanceOf(ProducedReviewHoldUnpersistedError);
    expect(err.delivered).toBe(true);

    const call = deliveredRecovery();
    expect(call).toBeDefined();
    const [, data, options] = call!;
    expect(data.runId).toBe("run-1");
    expect(data.producedReviewHoldPark).toBe(1);
    expect(options.jobId).toBe(`${PRODUCED_REVIEW_RECOVERY_JOB_PREFIX}run-1__1`);
    expect(options.delay).toBe(PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS);
    expect(
      Buffer.byteLength(JSON.stringify(data.producedReviewHold) ?? "", "utf8"),
    ).toBeLessThanOrEqual(PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES);

    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("the delivered payload lets a later convergence pass land the withheld verdict", async () => {
    await approveReviewTaskInternal("wayflow-task-1", "user-a").catch(() => undefined);
    const [, data] = deliveredRecovery()!;

    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    await recoverProducedReviewHold({
      runId: "run-1",
      run: { orgId: "org-1", status: "pending_approval" },
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park: data.producedReviewHoldPark as number,
    });

    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    expect([calls[0][1], calls[0][2]]).toEqual(["pending_approval", "completed"]);
    expect(calls[0][3]?.stepResults).toBeDefined();
    expect(calls[0][3]?.derivationOutbox).toMatchObject({ contentHash: expect.any(String) });
  });

  it("a recovery that still cannot record the hold queues the NEXT delivery, capped", async () => {
    await approveReviewTaskInternal("wayflow-task-1", "user-a").catch(() => undefined);
    const [, data] = deliveredRecovery()!;
    enqueueSpy.mockClear();

    // The delivered leg re-raises: the write still fails.
    await recoverProducedReviewHold({
      runId: "run-1",
      run: { orgId: "org-1", status: "pending_approval" },
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park: data.producedReviewHoldPark as number,
    }).catch(() => undefined);

    const [, next, options] = deliveredRecovery()!;
    expect(next.producedReviewHoldPark).toBe(2);
    expect(options.jobId).toBe(`${PRODUCED_REVIEW_RECOVERY_JOB_PREFIX}run-1__2`);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});
