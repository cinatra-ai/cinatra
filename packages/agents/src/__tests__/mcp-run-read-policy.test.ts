/**
 * Tests for co-owner-aware read primitives:
 *   agent_run_get, agent_run_list, agent_run_messages_list
 *
 * These cases cover empty-list semantics and denial audit events for
 * run read handlers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthzError } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Auth-session mock
// ---------------------------------------------------------------------------
const SESSION_WITH_ORG = {
  user: {
    id: "co-owner-1",
    role: "user",
    name: "CoOwner",
    email: "co@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "s1",
    activeOrganizationId: "org-1",
    userId: "co-owner-1",
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
// Store mock
// ---------------------------------------------------------------------------
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
  readAgentRunById: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(),
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
// auth-policy mock
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// authz mock — for logAuditEvent + AuthzError + POLICY_VERSION
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
  buildListPage: vi.fn((items: unknown[], total: number) => ({ items, total, nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => ({ id: "co-owner-1" })),
}));

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------
type HandlerMap = Record<string, (req: Record<string, unknown>) => Promise<unknown>>;

// ---------------------------------------------------------------------------
// beforeEach — clear mocks and restore defaults
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
  authSessionMock.isPlatformAdmin.mockReturnValue(false);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helper: get handlers map fresh per test
// ---------------------------------------------------------------------------
async function getHandlers(): Promise<HandlerMap> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return createAgentBuilderPrimitiveHandlers() as HandlerMap;
}

// ---------------------------------------------------------------------------
// Shared run fixture
// ---------------------------------------------------------------------------
const BASE_RUN = {
  id: "run-1",
  templateId: "tpl-1",
  runBy: "owner-2",
  orgId: "org-1",
  status: "completed",
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
  coOwnerUserIds: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("run read primitives: co-owner + empty-list + denial audit", () => {

  // -------------------------------------------------------------------------
  // Test 1: run_get co-owner — allowed, no denial audit
  // -------------------------------------------------------------------------
  it("Test 1: run_get co-owner — returns run, no logAuditEvent(denied)", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...BASE_RUN, coOwnerUserIds: ["co-owner-1"] });

    const result = await handlers["agent_run_get"]({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: { userId: "co-owner-1", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    // result is the run record (which has an error: null field); ensure no string error response
    expect(typeof (result as { error?: unknown })?.error === "string").toBe(false);
    expect((result as { id?: string })?.id).toBe("run-1");
    expect(authzMock.logAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: run_get non-owner — 403 + denial audit
  // -------------------------------------------------------------------------
  it("Test 2: run_get non-owner — returns { error: 'Run access denied.' } and emits denial audit", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const result = await handlers["agent_run_get"]({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: { userId: "user-3", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect(result).toEqual(expect.objectContaining({ error: "Run access denied." }));
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        operation: "read",
        resourceType: "agent_run",
        resourceId: "run-1",
        actorPrincipalId: "user-3",
        policyVersion: authzMock.POLICY_VERSION,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: run_get hidden — returns "Run not found:" but still emits denial audit
  // -------------------------------------------------------------------------
  it("Test 3: run_get hidden — returns 'Run not found:' AND emits denial audit", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 404, reason: "hidden", message: "Run not found." }),
    );

    const result = await handlers["agent_run_get"]({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: { userId: "user-3", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect((result as { error?: string })?.error).toMatch(/Run not found/);
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        operation: "read",
        resourceType: "agent_run",
        resourceId: "run-1",
        actorPrincipalId: "user-3",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: run_list empty-list + per-row audit (all 3 rows denied)
  // -------------------------------------------------------------------------
  it("Test 4: run_list empty-list — returns { items:[], total:0 } and emits 3 denial audits", async () => {
    // Filtered-total semantics are required for the empty-list case.
    const handlers = await getHandlers();
    const rows = [
      { ...BASE_RUN, id: "run-a" },
      { ...BASE_RUN, id: "run-b" },
      { ...BASE_RUN, id: "run-c" },
    ];
    storeMock.readAgentRunsByTemplateRaw.mockResolvedValueOnce({ items: rows, total: 3 });
    authPolicyMock.enforceRunAccess.mockRejectedValue(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "denied" }),
    );
    storeMock.resolveRunCoOwnerUserIds.mockResolvedValue([]);

    const result = await handlers["agent_run_list"]({
      primitiveName: "agent_run_list",
      input: { templateId: "tpl-1" },
      actor: { userId: "user-3", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect((result as { items?: unknown[]; total?: number })?.items).toHaveLength(0);
    expect((result as { total?: number })?.total).toBe(0);
    expect(authzMock.logAuditEvent).toHaveBeenCalledTimes(3);
    for (const row of rows) {
      expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "denied",
          operation: "read",
          resourceType: "agent_run",
          resourceId: row.id,
        }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: run_list mixed — 1 allowed, 2 denied
  // -------------------------------------------------------------------------
  it("Test 5: run_list mixed — returns 1 allowed row, emits 2 denial audits", async () => {
    const handlers = await getHandlers();
    const rows = [
      { ...BASE_RUN, id: "run-a" },
      { ...BASE_RUN, id: "run-b", runBy: "user-3" },
      { ...BASE_RUN, id: "run-c" },
    ];
    storeMock.readAgentRunsByTemplateRaw.mockResolvedValueOnce({ items: rows, total: 3 });
    authPolicyMock.enforceRunAccess
      .mockRejectedValueOnce(new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "denied" }))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "denied" }));
    storeMock.resolveRunCoOwnerUserIds.mockResolvedValue([]);

    const result = await handlers["agent_run_list"]({
      primitiveName: "agent_run_list",
      input: { templateId: "tpl-1" },
      actor: { userId: "user-3", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect((result as { items?: unknown[] })?.items).toHaveLength(1);
    expect(authzMock.logAuditEvent).toHaveBeenCalledTimes(2);
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "run-a", decision: "denied" }),
    );
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "run-c", decision: "denied" }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: run_messages_list co-owner — allowed, no denial audit
  // -------------------------------------------------------------------------
  it("Test 6: run_messages_list co-owner — returns messages, no denial audit", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...BASE_RUN, coOwnerUserIds: ["co-owner-1"] });
    storeMock.readAgentRunMessages.mockResolvedValueOnce([
      { id: "msg-1", sequence: 1, role: "assistant", messageType: "text", body: "hello", createdAt: new Date() },
    ]);

    const result = await handlers["agent_run_messages_list"]({
      primitiveName: "agent_run_messages_list",
      input: { runId: "run-1" },
      actor: { userId: "co-owner-1", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect((result as { items?: unknown[] })?.items).toHaveLength(1);
    expect(authzMock.logAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: run_messages_list non-owner — 403 + denial audit
  // -------------------------------------------------------------------------
  it("Test 7: run_messages_list non-owner — returns { error: 'Run access denied.' } and emits denial audit", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const result = await handlers["agent_run_messages_list"]({
      primitiveName: "agent_run_messages_list",
      input: { runId: "run-1" },
      actor: { userId: "user-3", actorType: "human", source: "mcp" },
      mode: "deterministic",
    });

    expect(result).toEqual(expect.objectContaining({ error: "Run access denied." }));
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        operation: "read",
        resourceType: "agent_run",
        resourceId: "run-1",
        actorPrincipalId: "user-3",
        policyVersion: authzMock.POLICY_VERSION,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: A2A actor — denial audit includes authSource:"a2a"
  // -------------------------------------------------------------------------
  it("Test 8: A2A actor — denial audit includes authSource:'a2a' and actorPrincipalType:'a2a'", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const result = await handlers["agent_run_get"]({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: {
        userId: "svc-client-1",
        actorType: "a2a",
        source: "a2a",
        tokenScopes: ["agent.read"],
      },
      mode: "deterministic",
    });

    expect(result).toEqual(expect.objectContaining({ error: "Run access denied." }));
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        operation: "read",
        resourceType: "agent_run",
        actorPrincipalId: "svc-client-1",
        actorPrincipalType: "a2a",
        authSource: "a2a",
      }),
    );
  });
});
