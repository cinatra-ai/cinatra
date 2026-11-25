// cinatra#4150 (A5): `agent_run_resume` refuses a run held at a publish decision with
// code publish_decision_required. Nothing is recorded and nothing is sent into the held
// context. The harness is the one of produced-review-recovery-resume-primitive.test.ts.
// Since cinatra#4245 the road takes the pause claim before its fence; the hold is read
// before the claim and, on a publishing template or for a run with a decision, again
// under the claim and before the fence.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pauseClaimFake } from "./pause-claim-test-fake";
import * as midRun from "../orchestrator-mid-run-hitl";

// cinatra#4245: the resume road's pause claim always wins here unless a case says otherwise.
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));

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

// What declares a package's screen on the server: the bindings of this build
// (here filtered by `packScreens.dropped`, as a newer bundled pack that no longer
// ships the screen) and those of packages installed at run time (none by default).
const packScreens = vi.hoisted(() => ({
  dropped: [] as string[],
  installed: [] as Array<{ id: string; kind: string; priority: number; declaredBy: string }>,
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => {
  const real = await orig<typeof import("@/lib/generated/agent-bindings")>();
  return {
    ...real,
    get GENERATED_FIELD_RENDERER_BINDINGS() {
      return real.GENERATED_FIELD_RENDERER_BINDINGS.filter((b) => !packScreens.dropped.includes(b.id));
    },
  };
});
vi.mock("../field-renderer-bindings.server", () => ({
  collectInstalledFieldRendererBindings: () => packScreens.installed,
}));
/** The two publish packs' own confirmation screens, as their old pins declared them. */
const OLD_PUBLISH_SCREENS = [
  { id: "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm", kind: "wordpress-draft-confirm" },
  { id: "@cinatra-ai/blog-linkedin-publish-agent:draft-review", kind: "linkedin-draft-review" },
];

// The run's latest-task key, stubbed at its leaf as the transport is: none by default.
const latestKey = vi.hoisted(() => vi.fn<(runId: string) => Promise<string | null>>(async () => null));
vi.mock("../../../a2a/src/event-log", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveLatestWayflowGateTaskId: latestKey,
}));

const decisions = vi.hoisted(() => ({
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: decisions.readLatestDecisionForRun,
}));

// The paused step's durable record: none by default (a real absence), so the
// resume road goes on to the checks this suite is about.
const durableGate = vi.hoisted(() => ({
  read: vi.fn<(runId?: string, reviewTaskId?: string) => Promise<unknown>>(async () => null),
  // The run's current gate (its newest durable row): by default the record the
  // suite gives for the run's own task.
  current: vi.fn<(runId: string) => Promise<unknown>>(async () => null),
}));
const currentIsTheRunsTask = (runId: string) => durableGate.read(runId, "wayflow-task-1");
durableGate.current.mockImplementation(currentIsTheRunsTask);
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readDurableHitlGateForContinue: durableGate.read,
  readCurrentDurableHitlGate: durableGate.current,
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
      expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1", { orEarlierAttempt: true });
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

// cinatra#4150 PR 3a, pre-review 2 findings 2, 3 and 5, settled with cinatra#4245: on a template that lists publishing
// steps the road takes the pause claim, reads the hold again under it and only then fences (pending_approval -> running)
// and sends, so a decision another resume parked after this road's first read refuses the send and gives the claim back;
// a send that fails after the fence leaves the run running with its claim settled; an unreadable hold answers a fixed text.
describe("agent_run_resume on a publishing template", () => {
  const row = { status: "pending_approval" };
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

  beforeEach(() => {
    vi.clearAllMocks();
    // Once-answers a case leaves (a red run over older code) must not feed the next case.
    for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readLatestDecisionForRun, sendTaskSpy]) m.mockReset();
    pauseClaimFake.claimPause.mockReset().mockImplementation(async () => ({ kind: "claimed", token: "tok-fake", generation: 1, expiresAt: new Date(0) }));
    pauseClaimFake.releasePauseClaim.mockReset().mockImplementation(async () => "released");
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

  it("claims the pause, reads the hold again under the claim, then fences and sends", async () => {
    await resume();
    expect(moves()[0]).toEqual(["run-1", "pending_approval", "running"]);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(2);
    expect(pauseClaimFake.claimPause.mock.invocationCallOrder[0]!).toBeLessThan(
      decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!,
    );
    expect(decisions.readLatestDecisionForRun.mock.invocationCallOrder[1]!).toBeLessThan(
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
    );
    expect(storeMock.transitionRunStatus.mock.invocationCallOrder[0]!).toBeLessThan(sendTaskSpy.mock.invocationCallOrder[0]!);
    // The task is then handled from where the fence put the run, never from pending_approval.
    expect(moves().slice(1).every(([, from]) => from !== "pending_approval")).toBe(true);
  });

  it("a decision parked by another resume after the first read refuses the send and gives the claim back", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "parked" });
    const answer = (await resume()) as { error?: string; code?: string };
    expect(answer.code).toBe("publish_decision_required");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("pending_approval");
  });

  it("a hold that cannot be read under the claim answers the fixed text, sends nothing and gives the claim back", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("db down: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = (await resume()) as { error?: string; code?: string };
      expect(answer.error).toMatch(/publish hold could not be checked/);
      expect(answer.error).not.toMatch(/db down|run-1/);
      for (const c of warn.mock.calls) expect(c.map(String).join(" ")).not.toMatch(/db down|run-1/);
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
  });

  it("a refusal under the claim whose release fails still answers the refusal and logs no run or raw error", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "parked" });
    pauseClaimFake.releasePauseClaim.mockRejectedValueOnce(new Error("release failed: run-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = (await resume()) as { error?: string; code?: string };
      expect(answer.code).toBe("publish_decision_required");
      const ours = warn.mock.calls.filter((c) => String(c[0]).includes("could not give the claim back"));
      expect(ours).toHaveLength(1);
      for (const c of ours) expect(c.map(String).join(" ")).not.toMatch(/run-1|release failed/);
    } finally {
      warn.mockRestore();
    }
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
  });

  it("a pause another resume holds is sent nothing", async () => {
    pauseClaimFake.claimPause.mockResolvedValueOnce({ kind: "refused", reason: "held", status: "pending_approval", generation: 1 } as never);
    const answer = (await resume()) as { error?: string };
    expect(typeof answer.error).toBe("string");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
  });

  it("a send that fails after the fence leaves the run running with its claim settled, and a retry is refused and sends nothing", async () => {
    sendTaskSpy.mockRejectedValueOnce(new Error("socket hang up"));
    await resume().catch(() => undefined);
    expect(row.status).toBe("running");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(pauseClaimFake.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.releasePauseClaim).not.toHaveBeenCalled();
    pauseClaimFake.claimPause.mockResolvedValueOnce({ kind: "refused", reason: "not-pending", status: "running", generation: 2 } as never);
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
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
  });
});

// cinatra#4150 PR 3a, pre-review 3 finding 1: a verified publish-gate claim holds a run whatever the live template lists, so
// a run that already met a publish gate (it has a decision) reads the hold again under the claim on every template.
describe("agent_run_resume on a template that lists no publishing step, for a run with a decision", () => {
  const row = { status: "pending_approval" };
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readLatestDecisionForRun, sendTaskSpy]) m.mockReset();
    pauseClaimFake.claimPause.mockReset().mockImplementation(async () => ({ kind: "claimed", token: "tok-fake", generation: 1, expiresAt: new Date(0) }));
    pauseClaimFake.releasePauseClaim.mockReset().mockImplementation(async () => "released");
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

  it("a decision parked by another resume after the first read refuses the send and gives the claim back", async () => {
    decisions.readLatestDecisionForRun
      .mockResolvedValueOnce({ id: "d1", runId: "run-1", status: "released" })
      .mockResolvedValueOnce({ id: "d2", runId: "run-1", status: "parked" });
    const answer = (await resume()) as { error?: string; code?: string };
    expect(answer.code).toBe("publish_decision_required");
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("pending_approval");
  });

  it("a released decision that is still the newest: the hold is read again under the claim, and the send goes from running", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "released" });
    await resume();
    expect(moves()[0]).toEqual(["run-1", "pending_approval", "running"]);
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(2);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a run with no decision reads the hold once; the pause claim and its fence go on as on every resume (cinatra#3745: every gate is claimed)", async () => {
    await resume();
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
    expect(moves()[0]).toEqual(["run-1", "pending_approval", "running"]);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
});

// THE PAUSED STEP'S DURABLE RECORD DECIDES WHETHER `agent_run_resume` MAY ANSWER IT.
// A display-only card (the artifact-review redirect) is consumed only by its
// review's own decision; a record that cannot be read refuses; only a real
// absence (`null`) goes on as before. Nothing is claimed, fenced, recorded or sent
// on a refusal, and the run stays parked.
describe("agent_run_resume and the paused step's durable record", () => {
  const gateFor = (xRenderer: string) => ({
    runId: "run-1",
    reviewTaskId: "wayflow-task-1",
    xRenderer,
    inputSchema: { type: "object" },
    values: {},
    materializedAt: "2026-11-25T00:00:00.000Z",
  });
  const nothingMoved = () => {
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(sendTaskSpy).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Implementations an earlier suite left (its fence's row) must not feed this one.
    for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readLatestDecisionForRun, sendTaskSpy]) m.mockReset();
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
    pauseClaimFake.claimPause.mockReset().mockImplementation(async () => ({ kind: "claimed", token: "tok-fake", generation: 1, expiresAt: new Date(0) }));
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    });
    sendTaskSpy.mockResolvedValue({
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed", message: { parts: [] } },
      metadata: {},
      history: [{ role: "agent", parts: [{ kind: "text", text: "done" }] }],
    });
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
    durableGate.read.mockReset().mockResolvedValue(null);
    durableGate.current.mockReset().mockImplementation(currentIsTheRunsTask);
    latestKey.mockReset().mockResolvedValue(null);
  });

  // THE RUN'S CURRENT GATE DECIDES (its newest durable row), never the row its
  // task column names: that column can be stale, and the resume reaches the
  // current gate through the run's context.
  // red-first-expect: to not be called at all, but actually been called 1 times
  it("an answerable row under the run's stale task does not open a display-only current gate", async () => {
    // The run's latest-task key names the newer task: the task column is stale.
    latestKey.mockResolvedValue("task-2");
    durableGate.read.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:schema-field-fallback"));
    durableGate.current.mockResolvedValue({
      ...gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"),
      reviewTaskId: "wayflow-task-2",
    });
    const answer = (await resume()) as { error?: string };
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(answer.error).toBe("Run run-1 is paused at an artifact review; it goes on only when that review is decided.");
    nothingMoved();
  });

  // red-first-expect: to be called with arguments: [ 'run-1' ]
  it("a display-only row under the run's stale task does not refuse an answerable current gate", async () => {
    durableGate.read.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"));
    durableGate.current.mockResolvedValue({
      ...gateFor("@cinatra-ai/agent-builder:schema-field-fallback"),
      reviewTaskId: "wayflow-task-2",
    });
    const answer = (await resume()) as { error?: string };
    expect(durableGate.current).toHaveBeenCalledWith("run-1");
    // The resume goes on to the claim and the send (what follows the send is
    // other suites' concern).
    expect(answer.error ?? "").not.toMatch(/artifact review|could not be read/);
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  // red-first-expect: to be called with arguments: [ 'run-1' ]
  it("the current gate is read for the run, and its refusal stands whatever the task's row says", async () => {
    durableGate.read.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:schema-field-fallback"));
    durableGate.current.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"));
    const answer = (await resume()) as { error?: string };
    expect(durableGate.current).toHaveBeenCalledWith("run-1");
    expect(answer.error).toBe("Run run-1 is paused at an artifact review; it goes on only when that review is decided.");
    nothingMoved();
  });

  // red-first-expect: to not be called at all, but actually been called 1 times
  it("a pause on the display-only artifact-review redirect is refused and not consumed", async () => {
    durableGate.read.mockResolvedValue(gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"));
    const answer = (await resume()) as { error?: string };
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(answer.error).toBe("Run run-1 is paused at an artifact review; it goes on only when that review is decided.");
    nothingMoved();
  });

  // red-first-expect: to not be called at all, but actually been called 1 times
  it("a durable record that cannot be read refuses with a fixed text; nothing is claimed or sent", async () => {
    durableGate.read.mockRejectedValue(new Error("permission denied for table agent_run_hitl_gates"));
    const answer = (await resume()) as { error?: string };
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(answer.error).toBe("Run run-1 cannot be resumed: its paused step could not be read.");
    nothingMoved();
  });

  it("no durable record (a real null) is resumed as before", async () => {
    await resume();
    expect(durableGate.read).toHaveBeenCalledWith("run-1", "wayflow-task-1");
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("an ordinary builder input step still answers", async () => {
    for (const id of [
      "@cinatra-ai/agent-builder:schema-field-fallback",
      "@cinatra-ai/agent-builder:grouped-setup-form",
      "@cinatra-ai/agent-builder:personal-skill",
    ]) {
      sendTaskSpy.mockClear();
      durableGate.read.mockResolvedValue(gateFor(id));
      await resume();
      expect(sendTaskSpy, id).toHaveBeenCalledTimes(1);
    }
  });

  // A PACKAGE'S OWN SCREEN THAT NO PACKAGE DECLARES ANY MORE IS RETIRED: the
  // flow installed under the run changed (`hitlStepIsRetired`).
  // red-first-expect: to be 'Run run-1 is paused at a retired step
  it("a package screen that no binding declares is refused as retired", async () => {
    durableGate.read.mockResolvedValue(gateFor("@acme/removed:output"));
    const answer = (await resume()) as { error?: string };
    expect(answer.error).toBe("Run run-1 is paused at a retired step; it can no longer be answered.");
    nothingMoved();
  });

  for (const screen of OLD_PUBLISH_SCREENS) {
    // red-first-expect: to be 'Run run-1 is paused at a retired step
    it(`${screen.id}: refused once the bundled pack no longer declares it and no installed pack does`, async () => {
      packScreens.dropped = [screen.id];
      packScreens.installed = [];
      durableGate.read.mockResolvedValue(gateFor(screen.id));
      const answer = (await resume()) as { error?: string };
      packScreens.dropped = [];
      expect(answer.error).toBe("Run run-1 is paused at a retired step; it can no longer be answered.");
      nothingMoved();
    });
    it(`${screen.id}: resumed where an installed older pack still declares it (its old flow runs)`, async () => {
      packScreens.dropped = [screen.id];
      packScreens.installed = [{ id: screen.id, kind: screen.kind, priority: 90, declaredBy: "installed" }];
      durableGate.read.mockResolvedValue(gateFor(screen.id));
      await resume();
      packScreens.dropped = [];
      packScreens.installed = [];
      expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
      expect(sendTaskSpy).toHaveBeenCalledTimes(1);
    });
  }

  // THE SERVER REFUSES WHAT THE HOSTS WITHHOLD: a retired step (the set every
  // host draws no Continue for) is answered by nothing, under any id of it.
  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("a pause on any retired step is refused and not consumed", async () => {
    const retired = [
      ...midRun.TOMBSTONED_HITL_RENDERER_IDS,
      `${[...midRun.TOMBSTONED_HITL_RENDERER_PACKAGES][0]}:any-step`,
    ];
    for (const id of retired) {
      expect(midRun.parkedHitlStepIsAnswerable(id, null), id).toBe(false);
      durableGate.read.mockResolvedValue(gateFor(id));
      const answer = (await resume()) as { error?: string };
      expect(answer.error, id).toBe("Run run-1 is paused at a retired step; it can no longer be answered.");
      nothingMoved();
    }
  });

  // WHICH STEP THE RUN WAITS AT is decided by its row and latest-task key; a
  // durable row only confirms it. An older step's display-only row, newest
  // because the current step's row was never written, refuses nothing.
  it("an older step's display-only row does not refuse the step the run waits at", async () => {
    durableGate.current.mockResolvedValue({
      ...gateFor("@cinatra-ai/agent-builder:artifact-review-redirect"),
      reviewTaskId: "wayflow-task-0",
    });
    latestKey.mockResolvedValue("task-1");
    const answer = (await resume()) as { error?: string };
    expect(answer.error ?? "").not.toMatch(/artifact review|could not be read/);
    expect(pauseClaimFake.claimPause).toHaveBeenCalledTimes(1);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
});
