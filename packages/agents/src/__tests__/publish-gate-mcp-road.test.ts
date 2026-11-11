// cinatra#4150 (A5): `agent_run_resume` refuses a run held at a publish decision with
// code publish_decision_required. Nothing is recorded and nothing is sent into the held
// context. The harness is the one of produced-review-recovery-resume-primitive.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
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
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
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

const decisions = vi.hoisted(() => ({
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: decisions.readLatestDecisionForRun,
}));

const ACTOR = { actorType: "human" as const, source: "ui" as const, userId: "user-a" };

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
    sourceType: "internal",
  };
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

describe("agent_run_resume and a publish decision", () => {
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
    // A finished task: the resumed leg ends, so the happy path needs no gate store.
    sendTaskSpy.mockResolvedValue({
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed", message: { parts: [] } },
      metadata: {},
      history: [{ role: "agent", parts: [{ kind: "text", text: "done" }] }],
    });
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
  });

  it.each(["parked", "declined", "expired", "run_ended"])(
    "a run whose newest decision is %s answers publish_decision_required and is sent nothing",
    async (status) => {
      decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status });
      const answer = (await resume()) as { error?: string; code?: string };
      expect(answer.code).toBe("publish_decision_required");
      expect(typeof answer.error).toBe("string");
      expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    },
  );

  it("an unreadable decision record refuses too", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down"));
    const answer = (await resume()) as { error?: string };
    expect(typeof answer.error).toBe("string");
    expect(sendTaskSpy).not.toHaveBeenCalled();
  });

  it("a run with no decision, or a released one, is resumed as before", async () => {
    await resume().catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "released" });
    await resume().catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(2);
  });
});

// cinatra#4150 PR 3a, pre-review 2 findings 2, 3 and 5: on a template that lists publishing steps the run is claimed
// (pending_approval -> running) right before the send and the hold is read again, so a decision another resume parked
// after this road's first read refuses the send; a send that fails after the claim leaves the run running, where no
// road resumes it; an unreadable hold answers a fixed text.
describe("agent_run_resume on a publishing template", () => {
  const row = { status: "pending_approval" };
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

  beforeEach(() => {
    vi.clearAllMocks();
    // Once-answers a case leaves (a red run over older code) must not feed the next case.
    for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readLatestDecisionForRun, sendTaskSpy]) m.mockReset();
    row.status = "pending_approval";
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockImplementation(async () => ({ ...pausedRun(), status: row.status }));
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "test-publishing-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
      publishingSteps: ["publish"],
    });
    storeMock.transitionRunStatus.mockImplementation((async (_runId: string, from: string, to: string) => {
      if (row.status !== from) throw Object.assign(new Error("stale"), { code: "stale_from_status" });
      row.status = to;
    }) as never);
    sendTaskSpy.mockResolvedValue({
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed", message: { parts: [] } },
      metadata: {},
      history: [{ role: "agent", parts: [{ kind: "text", text: "done" }] }],
    });
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
  });

  it("claims the run before the send and reads the hold after the claim", async () => {
    await resume();
    expect(moves()[0]).toEqual(["run-1", "pending_approval", "running"]);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(2);
    expect(storeMock.transitionRunStatus.mock.invocationCallOrder[0]!).toBeLessThan(
      decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!,
    );
    expect(decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!).toBeLessThan(sendTaskSpy.mock.invocationCallOrder[0]!);
    // The task is then handled from where the claim put the run, never from pending_approval.
    expect(moves().slice(1).every(([, from]) => from !== "pending_approval")).toBe(true);
  });

  it("a decision parked by another resume after the first read refuses the send and puts the run back", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "parked" });
    const answer = (await resume()) as { error?: string; code?: string };
    expect(answer.code).toBe("publish_decision_required");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
    expect(row.status).toBe("pending_approval");
  });

  it("a run another resume holds is sent nothing", async () => {
    row.status = "running"; // the claim of the other resume; this one read the run before it
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...pausedRun(), status: "pending_approval" });
    const answer = (await resume()) as { error?: string };
    expect(typeof answer.error).toBe("string");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(row.status).toBe("running");
  });

  it("a send that fails after the claim leaves the run running, and a retry is refused and sends nothing", async () => {
    sendTaskSpy.mockRejectedValueOnce(new Error("socket hang up"));
    await resume().catch(() => undefined);
    expect(row.status).toBe("running");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    const retry = (await resume()) as { error?: string };
    expect(retry.error).toMatch(/not pending approval/);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("an unreadable hold answers a fixed text that names no run and no store error", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = (await resume()) as { error?: string };
      expect(answer.error).toMatch(/publish hold could not be checked/);
      expect(answer.error).not.toMatch(/db down|run-1/);
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
  });
});

// cinatra#4150 PR 3a, pre-review 3 finding 1: a verified publish-gate claim holds a run whatever the live template lists, so
// a run that already met a publish gate (it has a decision) is claimed before the send on every template.
describe("agent_run_resume on a template that lists no publishing step, for a run with a decision", () => {
  const row = { status: "pending_approval" };
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));
  const claimed = (m: unknown[][]) => m.some(([, from, to]) => from === "pending_approval" && to === "running");

  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readLatestDecisionForRun, sendTaskSpy]) m.mockReset();
    row.status = "pending_approval";
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockImplementation(async () => ({ ...pausedRun(), status: row.status }));
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    storeMock.transitionRunStatus.mockImplementation((async (_runId: string, from: string, to: string) => {
      if (row.status !== from) throw Object.assign(new Error("stale"), { code: "stale_from_status" });
      row.status = to;
    }) as never);
    sendTaskSpy.mockResolvedValue({
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed", message: { parts: [] } },
      metadata: {},
      history: [{ role: "agent", parts: [{ kind: "text", text: "done" }] }],
    });
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
  });

  it("a decision parked by another resume after the first read refuses the send and puts the run back", async () => {
    decisions.readLatestDecisionForRun
      .mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "released" })
      .mockResolvedValueOnce({ id: "d2", runId: "run-1", status: "parked" });
    const answer = (await resume()) as { error?: string; code?: string };
    expect(answer.code).toBe("publish_decision_required");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
    expect(row.status).toBe("pending_approval");
  });

  it("a released decision that is still the newest: the run is claimed, the hold read again, and the send goes from running", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "released" });
    await resume();
    expect(moves()[0]).toEqual(["run-1", "pending_approval", "running"]);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(2);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a run with no decision is not claimed: the hold is read once and the road goes on as on main", async () => {
    await resume();
    expect(claimed(moves())).toBe(false);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(1);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
});
