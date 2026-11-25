// cinatra#3470: THE ASSISTANT'S TEXT ROAD SENDS A DECLARED CARD'S STEP NOTHING.
// `agent_run_resume` sends a bare text answer, never a declared card's whole answer, so
// a step a bundled agent's declared card draws is refused there: the person answers it
// on the card, whose answer the approval road checks. A gate row that cannot be read,
// for an agent that declares a card, refuses too. The harness is the one of
// publish-gate-mcp-road.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { CARD_ID, PLAIN_ID, CARD_SCREEN } = vi.hoisted(() => ({
  CARD_ID: "@acme/card-agent:brief",
  PLAIN_ID: "@acme/card-agent:confirm",
  CARD_SCREEN: { layout: "card", sections: [{ type: "field", key: "angle", label: "Angle" }] },
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GENERATED_FIELD_RENDERER_BINDINGS: [
    {
      id: CARD_ID,
      kind: "cta",
      priority: 90,
      midRunHitl: true,
      screen: CARD_SCREEN,
      declaredBy: "@acme/card-agent",
    },
    { id: PLAIN_ID, kind: "cta", priority: 90, midRunHitl: true, declaredBy: "@acme/card-agent" },
  ],
}));
const gateRow = vi.hoisted(() => ({
  read: "row" as "row" | "missing" | "throws",
  xRenderer: "",
  inputSchema: {} as Record<string, unknown>,
}));
vi.mock("../agent-run-hitl-prompts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) => {
    if (gateRow.read === "throws") throw new Error("fixture gate store down");
    if (gateRow.read === "missing") return null;
    return { runId, reviewTaskId, xRenderer: gateRow.xRenderer, inputSchema: gateRow.inputSchema, values: {}, materializedAt: "2026-01-01T00:00:00.000Z" };
  },
}));

import { createHash } from "node:crypto";

/** The stored form of a card, as the pause records it: the card and the sha-256 of its canonical JSON. */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);
const storedCard = (screen: unknown) => ({
  "x-declared-screen": { screen, digest: `sha256:${createHash("sha256").update(canon(screen)).digest("hex")}` },
});

describe("agent_run_resume and a declared card's step (cinatra#3470)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateRow.read = "row";
    gateRow.xRenderer = CARD_ID;
    // The pause was recorded with the card: the one writer stamped the row's schema.
    gateRow.inputSchema = { type: "object", ...storedCard(CARD_SCREEN) };
    authSessionMock.getAuthSession.mockResolvedValue(null);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
    enforceRunAccessSpy.mockResolvedValue(undefined);
    storeMock.readAgentRunById.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@acme/card-agent",
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

  it.each([["row" as const], ["missing" as const], ["throws" as const]])(
    "refuses a step a declared card draws (gate row: %s) and sends nothing",
    async (read) => {
      gateRow.read = read;
      const answer = (await resume()) as { error?: string };
      expect(answer.error).toMatch(/answered on its card/);
      expect(sendTaskSpy).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    },
  );

  it("a row that stored no card (paused before the card was recorded) is resumed as before", async () => {
    gateRow.inputSchema = { type: "object" };
    await resume().catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("a step with no declared card is resumed as before", async () => {
    gateRow.xRenderer = PLAIN_ID;
    gateRow.inputSchema = { type: "object" };
    await resume().catch(() => undefined);
    expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  });
});
