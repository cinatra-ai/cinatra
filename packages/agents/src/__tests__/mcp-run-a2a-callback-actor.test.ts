/**
 * Regression coverage: WayFlow callback actor resolution in handleAgentBuilderRunResume.
 *
 * BEFORE the fix the handler rewrote any A2A service identity's actor to
 * `{ ...actor, userId: run.runBy }` before enforceRunAccess, which forced the
 * owner short-circuit to fire for ANY class-authenticated A2A bearer that could
 * merely READ a pending owner-run — upgrading read-only A2A into the owner's
 * full resume/approve authority.
 *
 * AFTER the fix the substitution is removed: the ORIGINAL verified actor flows
 * into enforceRunAccess unchanged. These tests pin:
 *   - the actor passed to enforceRunAccess is NEVER rewritten to run.runBy
 *     (a foreign A2A service identity is evaluated as ITSELF and, with a real
 *     enforceRunAccess, would be denied);
 *   - the readUserById service-identity probe is gone (no longer imported/called);
 *   - a legitimate A2A self-resume (actor.userId === run.runBy) still passes
 *     through naturally via the owner short-circuit;
 *   - when enforceRunAccess denies, the handler surfaces an error and never
 *     reaches the WayFlow dispatch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
// better-auth-db mock — readUserById must NO LONGER be called (the
// service-identity probe was removed with the owner-substitution).
// ---------------------------------------------------------------------------
const betterAuthDbMock = vi.hoisted(() => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async (): Promise<{ id: string } | null> => null),
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
describe("handleAgentBuilderRunResume no longer substitutes the run owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authPolicyMock.enforceRunAccess.mockImplementation(async () => undefined);
    authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    storeMock.readAgentRunById.mockResolvedValue({ ...FAKE_RUN });
    storeMock.readRunCoOwners.mockResolvedValue([]);
    storeMock.transitionRunStatus.mockResolvedValue(undefined);
    betterAuthDbMock.readUserById.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // A FOREIGN A2A service identity is evaluated as ITSELF (NOT rewritten to
  // run.runBy), so a real enforceRunAccess denies.
  // -------------------------------------------------------------------------
  it("a foreign A2A service identity is passed UNCHANGED to enforceRunAccess (no owner substitution)", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "a2a", source: "a2a", userId: "svc-clientid-abc" },
      mode: "deterministic",
    });

    // The original actor userId is preserved; it must NEVER be rewritten to the
    // run owner ("owner-1").
    const executeCall = authPolicyMock.enforceRunAccess.mock.calls.find(
      (c: unknown[]) => c[2] === "execute",
    );
    expect(executeCall).toBeDefined();
    expect((executeCall![1] as { userId: string }).userId).toBe("svc-clientid-abc");
    // Explicitly assert the owner-substituted shape is NEVER produced.
    expect(authPolicyMock.enforceRunAccess).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "owner-1" }),
      "execute",
      expect.anything(),
    );
  });

  it("the readUserById service-identity probe is gone (never called)", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "a2a", source: "a2a", userId: "svc-clientid-abc" },
      mode: "deterministic",
    });

    expect(betterAuthDbMock.readUserById).not.toHaveBeenCalled();
  });

  it("a denied actor (enforceRunAccess throws) surfaces an error and does NOT reach WayFlow dispatch", async () => {
    authPolicyMock.enforceRunAccess.mockRejectedValue(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = (await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "a2a", source: "a2a", userId: "svc-foreign" },
      mode: "deterministic",
    })) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a legitimate A2A self-resume (actor.userId === run.runBy) passes the ORIGINAL actor (owner short-circuit handles it)", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      // The service genuinely dispatched this run: its userId IS run.runBy.
      actor: { actorType: "a2a", source: "a2a", userId: "owner-1" },
      mode: "deterministic",
    });

    const executeCall = authPolicyMock.enforceRunAccess.mock.calls.find(
      (c: unknown[]) => c[2] === "execute",
    );
    expect(executeCall).toBeDefined();
    // userId equals run.runBy by virtue of being the genuine owner — NOT by
    // the removed substitution.
    expect((executeCall![1] as { userId: string }).userId).toBe("owner-1");
  });

  it("non-a2a model actor is passed unchanged (no probe, no substitution)", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: "approved" },
      actor: { actorType: "model", source: "agent", userId: "user-2" },
      mode: "deterministic",
    });

    expect(betterAuthDbMock.readUserById).not.toHaveBeenCalled();
    const executeCall = authPolicyMock.enforceRunAccess.mock.calls.find(
      (c: unknown[]) => c[2] === "execute",
    );
    expect(executeCall).toBeDefined();
    expect((executeCall![1] as { userId: string }).userId).toBe("user-2");
  });
});
