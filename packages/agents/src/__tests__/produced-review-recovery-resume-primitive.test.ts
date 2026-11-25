import { describe, it, expect, vi, beforeEach } from "vitest";
import { pauseClaimFake } from "./pause-claim-test-fake";

// cinatra#4150: every resume road reads the run's newest publish decision before it
// sends. This suite is about another question, so no publish decision holds its run.
// The paused step has no durable row here: the answer goes on as before.
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readDurableHitlGateForContinue: async () => null,
}));

vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));

/**
 * cinatra#3007 — the resume primitive is a DIRECT resume caller: it drives the
 * same terminal handler the execution worker drives, and it owns no job it could
 * re-deliver. So when the hold cannot be recorded, the terminal write still owed
 * must already be on its own delivery by the time the sentinel reaches this
 * caller — otherwise the run sits non-terminal with nothing able to land its
 * verdict.
 */

const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
// cinatra#4245: the resume road's pause claim always wins here.
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

const storeMock = vi.hoisted(() => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateById: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(async () => ({ items: [], total: 0 })),
  readAgentRunMessages: vi.fn(),
  appendAgentRunMessage: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  readAgentTemplateVersions: vi.fn(),
  readAgentTemplateVersionById: vi.fn(async () => null),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  diffSnapshots: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  setAgentTemplatePackageName: vi.fn(),
  bulkStopAgentRuns: vi.fn(),
  bulkStopAgentRunsByTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplatePackageVersion: vi.fn(),
  writeHitlPrompt: vi.fn(async () => undefined),
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
  setAgentRunTokenHash: vi.fn(async () => {}),
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => ({ written: true })),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const enforceRunAccessSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../auth-policy", async (orig) => ({
  ...(await orig<typeof import("../auth-policy")>()),
  enforceRunAccess: enforceRunAccessSpy,
}));

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
// cinatra#3745: the handler binds the resume's answer to its claim (imported at the call).
const bindSpy = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => true));
vi.mock("../run-transition", () => ({ bindResumeLegToTask: bindSpy }));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s),
  assertSafePathSegment: (): void => undefined,
  listAgentPackages: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {}, body: "" })),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  listAccessibleOrgIdsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));

const sendTaskSpy = vi.hoisted(() => vi.fn(async (_req: unknown) => ({}) as unknown));
// The A2A transport is stubbed at its LEAF rather than at the package barrel:
// this handler is itself reachable from the barrel's own module graph, so a
// barrel factory that loads the original would pull this module in ahead of its
// own mock and the handler would end up holding the real client.
vi.mock("../../../a2a/src/external-client", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
}));

import {
  recoverProducedReviewHold,
  PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES,
  PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS,
  producedReviewRecoveryJobId,
  MAX_PRODUCED_REVIEW_HOLD_PARKS,
  CINATRA_ENDNODE_OUTPUTS_SENTINEL,
} from "../execution";

const AUTHORITY = { orgId: "org-1", can: () => true };
const ACTOR = { actorType: "human" as const, source: "ui" as const, userId: "user-a" };

function pausedRun() {
  return {
    id: "run-1",
    templateId: "tmpl-1",
    status: "pending_approval",
    a2aTaskId: "task-1",
    a2aContextId: "ctx-1",
    executionAttemptId: "attempt-1",
    orgId: "org-1",
    runBy: "user-a",
    authPolicy: null,
    packageVersion: "1.0.0",
    inputParams: {},
    createdAt: new Date("2026-01-01"),
    sourceType: "internal",
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

async function resume(): Promise<unknown> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers.agent_run_resume({
    primitiveName: "agent_run_resume",
    input: { runId: "run-1" },
    actor: ACTOR,
    mode: "deterministic",
  } as never);
}

describe("cinatra#3007 — an unrecordable hold inside the resume primitive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.getAuthSession.mockResolvedValue(null);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    sendTaskSpy.mockResolvedValue(completedTask());
    materializeSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "hold-unpersisted" });
  });

  it("puts the withheld terminal write on its delivery, and writes no terminal status", async () => {
    await resume().catch(() => undefined);

    const call = deliveredRecovery();
    expect(call).toBeDefined();
    const [, data, options] = call!;
    expect(data.runId).toBe("run-1");
    expect(data.producedReviewHoldPark).toBe(1);
    // Keyed on the run, its CHAIN and the ordinal — the chain is what keeps a
    // later chain's first delivery off an id a settled job still holds.
    expect(typeof data.producedReviewHoldChain).toBe("string");
    expect(options.jobId).toBe(
      producedReviewRecoveryJobId("run-1", data.producedReviewHoldChain as string, 1),
    );
    expect(options.delay).toBe(PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS);
    expect(
      Buffer.byteLength(JSON.stringify(data.producedReviewHold) ?? "", "utf8"),
    ).toBeLessThanOrEqual(PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES);

    // The only transition is the resume's own fence before its send (cinatra#4245's
    // pause claim, bound to the gate since cinatra#3745); no terminal status is written.
    const edges = (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string]>)
      .map((c) => [c[1], c[2]]);
    expect(edges).toEqual([["pending_approval", "running"]]);
  });

  it("the delivered payload lets a later convergence pass land the withheld verdict", async () => {
    await resume().catch(() => undefined);
    const [, data] = deliveredRecovery()!;
    // The resume claimed the gate before its send (cinatra#3745), so the run the
    // later pass finds is running.
    storeMock.transitionRunStatus.mockClear();

    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    await recoverProducedReviewHold({
      runId: "run-1",
      run: { orgId: "org-1", status: "running" },
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park: data.producedReviewHoldPark as number,
    });

    // cinatra#4245: leave the resume's fence out; this reads the convergence pass.
    const calls = (storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >).filter((c) => c[2] !== "running");
    expect(calls).toHaveLength(1);
    expect([calls[0][1], calls[0][2]]).toEqual(["running", "completed"]);
    expect(calls[0][3]?.stepResults).toBeDefined();
    // The withheld terminal write carries no derivation outbox: cinatra#3029
    // (PR 3311) retired the response-text derivation on the path that produced
    // this payload, so a replayed verdict must not claim one either.
    expect(calls[0][3]?.derivationOutbox).toBeUndefined();
  });
});

describe("cinatra#3745 — agent_run_resume claims the gate before it records or sends (under the pause claim, cinatra#4245)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.getAuthSession.mockResolvedValue(null);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    sendTaskSpy.mockResolvedValue(completedTask());
    holdSpy.mockResolvedValue({ held: true, reason: "hold-unpersisted" });
  });

  // Since cinatra#4245 the claim is the pause claim (claimPause) and the one move to
  // `running` is its fence, after the mint (run-resume-under-claim.ts); the fence carries
  // the gate (cinatra#3745).
  it("an already answered gate (the pause claim is refused: the run moved on) answers so; nothing is minted, fenced or sent", async () => {
    pauseClaimFake.claimPause.mockResolvedValueOnce(
      { kind: "refused", reason: "moved-on", status: "pending_approval", generation: 2 } as never,
    );
    const { mintResumeRunTokenMetadata } = await import("../wayflow-run-token-carrier");
    const result = (await resume()) as Record<string, unknown>;
    expect(result.error).toBe("Run moved on from the pause this resume read; nothing was sent.");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(mintResumeRunTokenMetadata).not.toHaveBeenCalled();
  });

  it("a fence that loses (stale_from_status: another gate or attempt) sends nothing, records nothing and gives the pause claim back", async () => {
    const { RunTransitionError } = await import("../run-status");
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new RunTransitionError({ code: "stale_from_status", runId: "run-1", from: "pending_approval", to: "running" }),
    );
    const result = (await resume()) as Record<string, unknown>;
    expect(result.error).toBe("This resume's claim on the pause expired before the send; nothing was sent. Resume again.");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
    // The rolled-back fence left this resume's claim in place (the run is at another
    // gate at the same generation): it is given back under its own token only.
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledWith(
      { runId: "run-1", orgId: "org-1", token: "tok-fake" },
      expect.anything(),
    );
    expect(pauseClaimFake.settlePauseSend).not.toHaveBeenCalled();
  });

  it("a lost fence whose release fails too still answers that nothing was sent, and logs no run or raw error", async () => {
    const { RunTransitionError } = await import("../run-status");
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new RunTransitionError({ code: "stale_from_status", runId: "run-1", from: "pending_approval", to: "running" }),
    );
    pauseClaimFake.releasePauseClaim.mockRejectedValueOnce(new Error("db down: run-1") as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = (await resume()) as Record<string, unknown>;
      expect(result.error).toBe("This resume's claim on the pause expired before the send; nothing was sent. Resume again.");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[resumeWayflowUnderPauseClaim] could not give the claim back after a lost fence",
        "Error",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a won claim comes before the mint, the mint before the fence, and the fence before the send", async () => {
    const order: string[] = [];
    pauseClaimFake.claimPause.mockImplementationOnce((async () => {
      order.push("claim");
      return { kind: "claimed", token: "tok-fake", generation: 1, expiresAt: new Date(0) };
    }) as never);
    storeMock.transitionRunStatus.mockImplementationOnce((async (_runId: string, from: string, to: string) => {
      order.push(`${from}->${to}`);
    }) as never);
    const { mintResumeRunTokenMetadata } = await import("../wayflow-run-token-carrier");
    vi.mocked(mintResumeRunTokenMetadata).mockImplementationOnce(async () => {
      order.push("mint");
      return {};
    });
    sendTaskSpy.mockImplementationOnce(async () => {
      order.push("send");
      return completedTask();
    });
    await resume().catch(() => undefined);
    expect(order.slice(0, 4)).toEqual(["claim", "mint", "pending_approval->running", "send"]);
  });

  it("the claim is bound to the gate the handler read: its a2a task and its execution attempt", async () => {
    await resume().catch(() => undefined);
    const [runId, from, to, meta] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string, string, string, { resumeGate?: Record<string, unknown> } | undefined,
    ];
    expect([runId, from, to]).toEqual(["run-1", "pending_approval", "running"]);
    expect(meta?.resumeGate).toMatchObject({ a2aTaskId: "task-1", executionAttemptId: "attempt-1" });
  });

  it("WayFlow's answer goes to the handler bound to the claim: the gate's task and its attempt", async () => {
    await resume().catch(() => undefined);
    expect(bindSpy).toHaveBeenCalledTimes(1);
    expect(bindSpy).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      orgId: "org-1",
      claimed: { a2aTaskId: "task-1", executionAttemptId: "attempt-1" },
      taskId: "task-1",
    }));
  });

  it("an answer that returns after the run left the claim moves nothing past the claim", async () => {
    bindSpy.mockResolvedValueOnce(false);
    await resume().catch(() => undefined);
    // The produced-review hold is never asked and no edge follows the claim.
    expect(holdSpy).not.toHaveBeenCalled();
    const edges = (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string]>)
      .map((c) => [c[1], c[2]]);
    expect(edges).toEqual([["pending_approval", "running"]]);
    expect(storeMock.updateAgentRunA2ATaskId).not.toHaveBeenCalled();
  });
});
