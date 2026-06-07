/**
 * Tests for WayFlow callback actor resolution in handleAgentBuilderRunResume.
 *
 * When a WayFlow worker callback arrives with actorType:"a2a" and a
 * service-identity userId (no human user row), the handler substitutes
 * run.runBy as the effective policy subject before calling enforceRunAccess.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthzError } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Auth-session mock
// ---------------------------------------------------------------------------
const SESSION_WITH_ORG = {
  user: {
    id: "owner-1",
    role: "user",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "s1",
    activeOrganizationId: "org-1",
    userId: "owner-1",
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    token: "t",
  },
};

const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => SESSION_WITH_ORG),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// ---------------------------------------------------------------------------
// better-auth-db mock — readUserById is the service-identity probe
// ---------------------------------------------------------------------------
const betterAuthDbMock = vi.hoisted(() => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  // Default: userId is NOT a human user row → service identity
  readUserById: vi.fn(async (_userId: string): Promise<{ id: string } | null> => null),
}));
vi.mock("@/lib/better-auth-db", () => betterAuthDbMock);

// ---------------------------------------------------------------------------
// Store mock
// ---------------------------------------------------------------------------
const FAKE_RUN = {
  id: "run-1",
  templateId: "tpl-1",
  versionId: null,
  runBy: "owner-1",
  orgId: "org-1",
  status: "pending_approval" as const,
  inputParams: {},
  stepResults: null,
  startedAt: null,
  completedAt: null,
  error: null,
  title: null,
  createdAt: new Date(),
  sourceType: "internal",
  sourceId: null,
  packageVersion: null,
  a2aTaskId: null,
  a2aContextId: null,
  parentRunId: null,
  agUiEnabled: null,
  lgThreadId: null,
  traceId: null,
  timeoutSeconds: null,
  streamedText: null,
  authPolicy: null,
};

const storeMock = vi.hoisted(() => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(async () => [{ id: "ver-1" }]),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  readAgentTemplateById: vi.fn(async () => ({
    id: "tpl-1",
    name: "Test Template",
    agentAuthPolicy: {
      runListVisibility: "owner",
      runDataVisibility: "owner",
      runExecuteVisibility: "owner",
      allowRunSharing: false,
    },
    status: "published",
    sourceType: "internal",
    packageName: null,
    type: "leaf",
  })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readAgentRunById: vi.fn(async () => FAKE_RUN) as any,
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunMessages: vi.fn(),
  appendAgentRunMessage: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class extends Error {
    code: string;
    constructor(message: string, code = "stale_from_status") {
      super(message);
      this.code = code;
    }
  },
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  readAgentTemplateVersions: vi.fn(),
  readAgentTemplateVersionById: vi.fn(),
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
}));
vi.mock("../store", () => storeMock);

// ---------------------------------------------------------------------------
// auth-policy mock — spy on enforceRunAccess so we can inspect the actor arg
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// authz mock
// ---------------------------------------------------------------------------
const authzMock = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode: number;
    reason: string;
    constructor({ statusCode, reason, message }: { statusCode: number; reason: string; message: string }) {
      super(message);
      this.statusCode = statusCode;
      this.reason = reason;
    }
  },
}));
vi.mock("@/lib/authz", () => authzMock);

// ---------------------------------------------------------------------------
// Other transitive dep mocks
// ---------------------------------------------------------------------------
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/skills", () => ({ upsertSkill: vi.fn(), parseFrontmatter: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("WayFlow callback actor resolution in handleAgentBuilderRunResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authPolicyMock.enforceRunAccess.mockImplementation(async () => undefined);
    authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    storeMock.readAgentRunById.mockResolvedValue({ ...FAKE_RUN });
    storeMock.readRunCoOwners.mockResolvedValue([]);
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
    // Default: service identity (no user row)
    betterAuthDbMock.readUserById.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // Test 1 — A2A service-identity callback resolves to run.runBy
  // -------------------------------------------------------------------------
  it("Test 1: a2a service-identity actor — enforceRunAccess called with run.runBy as userId", async () => {
    // Actor is service identity: actorType=a2a, userId has no user row
    betterAuthDbMock.readUserById.mockResolvedValue(null);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "a2a", source: "a2a", userId: "svc-clientid-abc" },
      mode: "deterministic",
    });

    // enforceRunAccess must have been called with effectiveActor.userId = run.runBy = "owner-1"
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ runBy: "owner-1" }),
      expect.objectContaining({ userId: "owner-1" }),
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — A2A human-actor callback is NOT substituted
  // -------------------------------------------------------------------------
  it("Test 2: a2a human-actor — enforceRunAccess called with original actor userId", async () => {
    // userId "human-user-1" IS a real user row
    betterAuthDbMock.readUserById.mockImplementation(async (id: string) =>
      id === "human-user-1" ? { id: "human-user-1" } : null,
    );

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "a2a", source: "a2a", userId: "human-user-1" },
      mode: "deterministic",
    });

    // enforceRunAccess must have been called with the original userId (not substituted)
    const executeCall = authPolicyMock.enforceRunAccess.mock.calls.find(
      (c: unknown[]) => c[2] === "execute",
    );
    expect(executeCall).toBeDefined();
    expect((executeCall![1] as { userId: string }).userId).toBe("human-user-1");
  });

  // -------------------------------------------------------------------------
  // Test 3 — Non-A2A actor — no substitution, standard enforceRunAccess
  // -------------------------------------------------------------------------
  it("Test 3: non-a2a model actor — no substitution, enforceRunAccess sees original actor", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "model", source: "agent", userId: "user-2" },
      mode: "deterministic",
    });

    // isA2aServiceIdentity short-circuits at actorType !== "a2a"
    // → readUserById should NOT be called
    expect(betterAuthDbMock.readUserById).not.toHaveBeenCalled();

    const executeCall = authPolicyMock.enforceRunAccess.mock.calls.find(
      (c: unknown[]) => c[2] === "execute",
    );
    expect(executeCall).toBeDefined();
    expect((executeCall![1] as { userId: string }).userId).toBe("user-2");
  });

  // -------------------------------------------------------------------------
  // Test 4 — A2A service-identity but run not found → error, no substitution
  // -------------------------------------------------------------------------
  it("Test 4: a2a service-identity with missing run — returns { error: 'Run not found' }", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "nonexistent-run" },
      actor: { actorType: "a2a", source: "a2a", userId: "svc-clientid-abc" },
      mode: "deterministic",
    }) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
    expect((result.error as string).toLowerCase()).toContain("not found");
    // No substitution attempted because no run.runBy to resolve
    expect(authPolicyMock.enforceRunAccess).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "owner-1" }),
      "execute",
      expect.anything(),
    );
  });
});
