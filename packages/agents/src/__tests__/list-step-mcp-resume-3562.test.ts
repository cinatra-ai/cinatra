// cinatra#3562: `agent_run_resume` answers a list step only with a list. A list
// step's pick is its list answer (`{type: "list", listId, …}` in the approvalNote,
// as the card's Continue lifts it); a resume whose answer names no list, or that
// carries no list answer at all for a step whose durable gate row is a list step,
// is refused with code LIST_STEP_ANSWER_NAMES_NO_LIST before the pause is
// claimed: nothing is recorded and nothing is sent. The harness is the one of
// publish-gate-mcp-road.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pauseClaimFake } from "./pause-claim-test-fake";

// The durable gate row of the paused step, when a case names its renderer.
const gateRow = vi.hoisted(() => ({ xRenderer: null as string | null }));
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  ...(await orig<typeof import("../agent-run-hitl-prompts")>()),
  readDurableHitlGateForContinue: vi.fn(async (runId: string, reviewTaskId: string) =>
    gateRow.xRenderer === null
      ? null
      : {
          runId,
          reviewTaskId,
          xRenderer: gateRow.xRenderer,
          inputSchema: { type: "object" },
          values: {},
          materializedAt: new Date(0).toISOString(),
        },
  ),
}));

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

const sendTaskSpy = vi.hoisted(() => vi.fn(async () => ({}) as unknown));
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

async function resume(answer: { userResponse?: string; approvalNote?: string } = {}): Promise<unknown> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers.agent_run_resume({
    primitiveName: "agent_run_resume",
    input: { runId: "run-1", ...answer },
    actor: ACTOR,
    mode: "deterministic",
  } as never);
}

const LIST_STEP = "@cinatra-ai/list-curator-agent:list-picker";
const note = (answer: Record<string, unknown>) => ({ approvalNote: JSON.stringify(answer) });

describe("agent_run_resume and a list step (cinatra#3562)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateRow.xRenderer = LIST_STEP;
    authSessionMock.getAuthSession.mockResolvedValue(null);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/list-curator-agent",
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
  });

  function expectRefused(answer: unknown) {
    expect((answer as { code?: string }).code).toBe("LIST_STEP_ANSWER_NAMES_NO_LIST");
    expect(typeof (answer as { error?: string }).error).toBe("string");
    expect(pauseClaimFake.claimPause).not.toHaveBeenCalled();
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  }

  // red-first-expect: expected undefined to be 'LIST_STEP_ANSWER_NAMES_NO_LIST'
  it("a list step resumed with no answer, or with a free text, is refused and sent nothing", async () => {
    expectRefused(await resume());
    expectRefused(await resume({ userResponse: "go on" }));
    expectRefused(await resume({ approvalNote: "looks fine" }));
  }, 20_000);

  // red-first-expect: expected undefined to be 'LIST_STEP_ANSWER_NAMES_NO_LIST'
  it("an answer naming no list is refused on a list step, tagged or not", async () => {
    expectRefused(await resume(note({ listId: "", listName: "" })));
    expectRefused(await resume(note({ type: "list", listIds: [" "] })));
  });

  it("an answer naming a list resumes the step as before, tagged or not", async () => {
    await resume(note({ type: "list", listId: "l-1", listName: "Q2 Targets" })).catch(() => undefined);
    await resume(note({ listId: "l-1", listName: "Q2 Targets" })).catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(2);
  });

  // The bare alias `list-picker` is a list step as a qualified id is.
  // red-first-expect: expected undefined to be 'LIST_STEP_ANSWER_NAMES_NO_LIST'
  it("a step whose row names the bare alias refuses an empty pick and resumes a named one", async () => {
    gateRow.xRenderer = "list-picker";
    expectRefused(await resume(note({ type: "list", listId: "", listName: "" })));
    await resume(note({ type: "list", listId: "l-1", listName: "Q2 Targets" })).catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a step of another kind is never judged as a list step, whatever its answer carries", async () => {
    gateRow.xRenderer = null;
    await resume(note({ type: "list", listId: "" })).catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a step of another kind resumed with a free text goes on as before", async () => {
    gateRow.xRenderer = "@cinatra-ai/web-research-agent:output";
    await resume({ userResponse: "go on" }).catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
});
