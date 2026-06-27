/**
 * Owner-only execute gate coverage for handleAgentBuilderRun
 * (agent_run MCP handler).
 *
 * These tests assert the execute gate runs before creation and enqueue,
 * preserves owner and admin allow paths, denies non-owner access, and applies
 * A2A token-scope gating.
 *
 * Tests 1-2: allow paths (owner / admin).
 * Tests 3: deny path (non-owner, owner-only policy).
 * Tests 4-5: A2A actor scope gating.
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
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// ---------------------------------------------------------------------------
// Store mock
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(async () => [{ id: "ver-1" }]),
  createAgentRun: vi.fn(async (args: { id: string; templateId: string }) => ({
    id: args.id,
    templateId: args.templateId,
    status: "queued",
    runBy: "owner-1",
    orgId: "org-1",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date(),
    versionId: null,
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
  })),
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
  readAgentRunById: vi.fn(),
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
// auth-policy mock — we let enforceRunAccess's behavior be controlled per-test
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// authz mock — for logAuditEvent
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
// Transitive dep mocks
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
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
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
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Background jobs mock (also needed as named import)
// ---------------------------------------------------------------------------
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function seedOwnerSession(): void {
  authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
  authSessionMock.isPlatformAdmin.mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("agent_run owner-only execute gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: allow (will be overridden per test for deny cases)
    authPolicyMock.enforceRunAccess.mockImplementation(async () => undefined);
    // Default: owner session
    seedOwnerSession();
    // Default store state
    storeMock.readAgentVersionsByTemplate.mockResolvedValue([{ id: "ver-1" }]);
    storeMock.createAgentRun.mockResolvedValue({
      id: "run-1",
      templateId: "tpl-1",
      status: "queued",
      runBy: "owner-1",
      orgId: "org-1",
      inputParams: {},
      createdAt: new Date(),
      versionId: null,
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
      stepResults: null,
      startedAt: null,
      completedAt: null,
      error: null,
      title: null,
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
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
    });
  });

  // -------------------------------------------------------------------------
  // Test 1 — Allow: owner actor, owner-only policy → run created
  // -------------------------------------------------------------------------
  it("Test 1: owner actor allowed — createAgentRun is called and returns { runId, status }", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(result).toHaveProperty("runId");
    expect(storeMock.createAgentRun).toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalled();
    // Gate must have been called before creation
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ runBy: "owner-1" }),
      expect.objectContaining({ userId: "owner-1" }),
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — Allow: platform_admin actor → run created regardless of policy
  // -------------------------------------------------------------------------
  it("Test 2: platform_admin actor allowed — createAgentRun is called", async () => {
    // Admin session
    authSessionMock.getAuthSession.mockResolvedValue({
      ...SESSION_WITH_ORG,
      user: { ...SESSION_WITH_ORG.user, role: "admin" },
    });
    authSessionMock.isPlatformAdmin.mockReturnValue(true);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "admin-user", platformRole: "platform_admin" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(storeMock.createAgentRun).toHaveBeenCalled();
    // Gate must have been called
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ runBy: "admin-user" }),
      expect.objectContaining({ userId: "admin-user" }),
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 3 — Deny: non-owner actor + owner-only policy → error, no DB write
  // -------------------------------------------------------------------------
  it("Test 3: non-owner denied — returns { error } and does NOT create run or enqueue job", async () => {
    // enforceRunAccess throws for non-owner
    authPolicyMock.enforceRunAccess.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "user-2" },
      mode: "deterministic",
    }) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
    expect((result.error as string).toLowerCase()).toContain("denied");
    expect(storeMock.createAgentRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    // Audit log denial
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", operation: "create" }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 4 — Allow: A2A actor with required execute scope → run created
  // -------------------------------------------------------------------------
  it("Test 4: a2a actor with execute scope allowed — createAgentRun is called", async () => {
    // enforceRunAccess allows (default mock behavior)
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "a2a", source: "a2a", userId: "owner-1", tokenScopes: ["agent.execute"] },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(storeMock.createAgentRun).toHaveBeenCalled();
    // Gate must have been called with the a2a actor
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ runBy: "owner-1" }),
      expect.objectContaining({ actorType: "a2a", tokenScopes: ["agent.execute"] }),
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — Deny: A2A actor missing execute scope → error, no DB write
  // -------------------------------------------------------------------------
  it("Test 5: a2a actor missing execute scope denied — returns { error } and does NOT create run", async () => {
    // enforceRunAccess throws for missing scope
    authPolicyMock.enforceRunAccess.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "a2a", source: "a2a", userId: "owner-1", tokenScopes: ["agent.read"] },
      mode: "deterministic",
    }) as Record<string, unknown>;

    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
    expect(storeMock.createAgentRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});
