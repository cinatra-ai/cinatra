/**
 * TDD tests for the AgentAuthPolicy enforcement wiring in
 * packages/agent-builder/src/mcp/handlers.ts.
 *
 * Coverage matrix:
 *
 *   Tests 1–8: Threading actor through to readAgentRunById +
 *     explicit enforceRunAccess gates in RunResume / RunStop +
 *     RunMessagesList.
 *   Tests 9–11: RunList — templateId branches to
 *     readAgentRunsByTemplate (which enforces internally), no-templateId
 *     stays on the readAgentRuns path.
 *
 * Mocks store + auth-policy + transitive deps so tests never hit a DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthzError } from "@/lib/authz";

// ---------------------------------------------------------------------------
// auth-session mock — read handlers call
// `getAuthSession()` + `isPlatformAdmin()` for org extraction. Without this mock the real
// `getAuthSession` would attempt to read Next.js request `headers()`, which
// is unavailable inside vitest.
//
// Default: returns `null` (no session). This preserves the write-handler invariant
// where `resolveRoleHintsFromSession()` resolves to `undefined`, matching
// the assertions of Tests 3/4/5/6/7 (RunResume / RunStop) which expect
// `undefined` as the fourth `enforceRunAccess` arg.
//
// Read-handler tests (Test 1/2/8/9/11) override the mock per-test to seed
// an active org so the missing-org guard does not short-circuit before the
// store-call assertion.
// ---------------------------------------------------------------------------
const SESSION_WITH_ORG = {
  user: {
    id: "u1",
    role: "user",
    name: "u",
    email: "u@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "s1",
    activeOrganizationId: "org-default",
    userId: "u1",
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
// Store mock — all functions handlers.ts imports from "../store"
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(async () => ({ items: [], total: 0 })),
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
  resolveDefaultOrgId: vi.fn(async () => "org-default"),
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
  // Co-owner loading used by handleAgentBuilderRunResume /
  // handleAgentBuilderRunStop / handleAgentBuilderRunMessagesList.
  // Required here to keep test isolation intact.
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
}));
vi.mock("../store", () => storeMock);

// ---------------------------------------------------------------------------
// auth-policy mock — handlers.ts imports enforceRunAccess from "../auth-policy"
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn() as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// Other transitive deps that must not hit real impls
// ---------------------------------------------------------------------------
vi.mock("../compiler", () => ({
  compileWorkflow: vi.fn(),
}));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({
  listAgentPackages: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {}, body: "" })),
}));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));

// handlers.ts imports readUserById for the isA2aServiceIdentity probe.
// Mock it here to avoid hitting the DB.
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  // The implementation calls readProjectGrantsForUser via the canonical resolver.
  // readProjectsForUser is retained for callsites that still use it.
  readProjectGrantsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  listAccessibleOrgIdsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));


const ACTOR = {
  actorType: "human" as const,
  source: "ui" as const,
  userId: "u1",
};

const FAKE_RUN = {
  id: "run-1",
  templateId: "tpl-1",
  versionId: null,
  runBy: "u1",
  status: "pending_approval",
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
// Helper for read-handler tests: seed an active-org session so the
// handler-level org guard does not 403 before the store-call assertion fires.
// Read-handler assertions expect `roles=undefined` for the third arg of `readAgentRunById`, so
// `isPlatformAdmin` stays false and `resolveRoleHintsFromSession()` returns
// `{ platformRole: "member" }` — but the assertions accept that because
// they do not validate role-hints forwarding. Tests that explicitly
// assert `undefined` for the role-hints arg use `seedActiveOrg(false)` for
// the mock-history clarity and accept the active-org payload.
function seedActiveOrg(): void {
  authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
  authSessionMock.isPlatformAdmin.mockReturnValue(false);
}

// handlers chain dynamically imports `../mcp/handlers`, which transitively
// loads the cinatra workspace MCP graph;
// cold-start on the first test of the file occasionally exceeds the 5s default
// when run alongside the full 72-file suite. Bump to 15s to absorb the
// import-time variance without masking real failures.
describe("handlers enforce run access via request.actor", { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authPolicyMock.enforceRunAccess.mockImplementation(async () => undefined);
    // Default: no session for write-handler tests.
    // Read-handler tests opt in via seedActiveOrg().
    authSessionMock.getAuthSession.mockResolvedValue(null);
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // Test 1 — RunGet: AuthzError propagates as { error: ... } from catch
  // -------------------------------------------------------------------------
  it("Test 1: RunGet returns { error } when readAgentRunById throws AuthzError", async () => {
    seedActiveOrg();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_get({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(result).toEqual({ error: expect.stringContaining("Run access denied.") });
  });

  // -------------------------------------------------------------------------
  // Test 2 — RunGet: returns the run when readAgentRunById resolves
  // -------------------------------------------------------------------------
  it("Test 2: RunGet returns the run unchanged when readAgentRunById resolves", async () => {
    seedActiveOrg();
    storeMock.readAgentRunById.mockResolvedValueOnce(FAKE_RUN);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_get({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(result).toEqual(FAKE_RUN);
    // Verify actor is forwarded (cast to PrimitiveActorContext).
    // Read-handler tests seed an active-org session, so `resolveRoleHintsFromSession()`
    // produces `{ platformRole: "member" }`. ActorRoleHints includes empty arrays
    // for project/team scope.
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1", ACTOR, { platformRole: "member", actorOrganizationId: "org-default", projectGrants: [], teamIds: [] });
  });

  // -------------------------------------------------------------------------
  // Test 3 — RunResume: enforceRunAccess(execute) throws → handler returns error
  // -------------------------------------------------------------------------
  it("Test 3: RunResume returns error when enforceRunAccess('execute') throws", async () => {
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...FAKE_RUN, status: "pending_approval" });
    authPolicyMock.enforceRunAccess.mockImplementation(async (_run, _actor, op) => {
      if (op === "execute") {
        throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." });
      }
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(result).toEqual({ error: expect.stringContaining("Run access denied.") });
    // execute is checked; pending_approval state was set first
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      ACTOR,
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 4 — RunResume: enforceRunAccess passes execute, throws on approveHitl
  // -------------------------------------------------------------------------
  it("Test 4: RunResume returns error when enforceRunAccess('approveHitl') throws", async () => {
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...FAKE_RUN, status: "pending_approval" });
    authPolicyMock.enforceRunAccess.mockImplementation(async (_run, _actor, op) => {
      if (op === "approveHitl") {
        throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." });
      }
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(result).toEqual({ error: expect.stringContaining("Run access denied.") });
    // approveHitl branch fires for pending_approval runs
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      ACTOR,
      "approveHitl",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — RunResume happy path: enforceRunAccess passes for execute + approveHitl
  // -------------------------------------------------------------------------
  it("Test 5: RunResume passes when enforceRunAccess resolves cleanly", async () => {
    // RunResume performs a single template lookup on the happy path.
    // Run has no a2aTaskId → falls into the setup-{runId} branch
    storeMock.readAgentRunById.mockResolvedValueOnce({
      ...FAKE_RUN,
      status: "pending_approval",
      a2aTaskId: null,
    });
    storeMock.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl-1",
      sourceType: "internal",
      packageName: "@cinatra/agent",
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", userResponse: JSON.stringify({ foo: "bar" }) },
      actor: ACTOR,
      mode: "deterministic",
    });
    // Setup-phase resume returns { runId, status: "resuming", message } once the
    // setup-input gate is satisfied — a JSON-object userResponse is now required.
    expect(result).toMatchObject({ runId: "run-1", status: "resuming" });
    // Both gates were called
    const opCalls = authPolicyMock.enforceRunAccess.mock.calls.map((c) => c[2]);
    expect(opCalls).toContain("execute");
    expect(opCalls).toContain("approveHitl");
  });

  // -------------------------------------------------------------------------
  // Test 6 — RunResume with explicit hitl response payload triggers respondToHitl
  // -------------------------------------------------------------------------
  it("Test 6: RunResume calls enforceRunAccess('respondToHitl') when input has a hitl response payload", async () => {
    storeMock.readAgentRunById.mockResolvedValueOnce({
      ...FAKE_RUN,
      status: "pending_approval",
      a2aTaskId: null,
    });
    storeMock.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl-1",
      sourceType: "internal",
      packageName: "@cinatra/agent",
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    await handlers.agent_run_resume({
      primitiveName: "agent_run_resume",
      input: { runId: "run-1", hitlResponse: { decision: "approved" } } as Record<string, unknown>,
      actor: ACTOR,
      mode: "deterministic",
    });
    const opCalls = authPolicyMock.enforceRunAccess.mock.calls.map((c) => c[2]);
    expect(opCalls).toContain("execute");
    expect(opCalls).toContain("approveHitl");
    expect(opCalls).toContain("respondToHitl");
  });

  // -------------------------------------------------------------------------
  // Test 7 — RunStop: enforceRunAccess throws → handler returns error
  // -------------------------------------------------------------------------
  it("Test 7: RunStop returns error when enforceRunAccess throws", async () => {
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...FAKE_RUN, status: "running" });
    authPolicyMock.enforceRunAccess.mockImplementation(async (_run, _actor, op) => {
      if (op === "execute") {
        throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." });
      }
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_stop({
      primitiveName: "agent_run_stop",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(result).toEqual({ error: expect.stringContaining("Run access denied.") });
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      ACTOR,
      "execute",
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Test 8 — RunMessagesList passes actor through to readAgentRunById
  // -------------------------------------------------------------------------
  it("Test 8: RunMessagesList forwards actor to readAgentRunById", async () => {
    seedActiveOrg();
    storeMock.readAgentRunById.mockResolvedValueOnce(FAKE_RUN);
    storeMock.readAgentRunMessages.mockResolvedValueOnce([]);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    await handlers.agent_run_messages_list({
      primitiveName: "agent_run_messages_list",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    // With the seeded active-org session, role hints resolve to
    // `{ platformRole: "member" }` and include project/team scope arrays.
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith("run-1", ACTOR, { platformRole: "member", actorOrganizationId: "org-default", projectGrants: [], teamIds: [] });
  });

  // -------------------------------------------------------------------------
  // Test 9 — RunList with templateId routes to readAgentRunsByTemplate
  //          and forwards actor when can() resolves
  // -------------------------------------------------------------------------
  // readAgentRunsByTemplateRaw is used for per-row policy enforcement and
  // empty-list semantics. readAgentRunsByTemplate is
  // no longer called for the templateId branch.
  it("Test 9: RunList({ templateId }) calls readAgentRunsByTemplateRaw and returns the page", async () => {
    seedActiveOrg();
    storeMock.readAgentRunsByTemplateRaw.mockResolvedValueOnce({ items: [], total: 0 });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_list({
      primitiveName: "agent_run_list",
      input: { templateId: "t1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(storeMock.readAgentRunsByTemplateRaw).toHaveBeenCalledWith(
      "t1",
      expect.any(Object),
    );
    expect(storeMock.readAgentRunsByTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ items: [] });
  });

  // -------------------------------------------------------------------------
  // Test 10 — RunList with templateId + per-row denial → empty list (not error)
  // Empty-list semantics replace error propagation.
  // -------------------------------------------------------------------------
  it("Test 10: RunList({ templateId }) returns empty list when all rows are denied (not an error)", async () => {
    seedActiveOrg();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (storeMock.readAgentRunsByTemplateRaw as any).mockResolvedValueOnce({
      items: [{ id: "run-x", templateId: "t1", runBy: "other", orgId: "org-default", status: "completed", inputParams: {}, stepResults: null, startedAt: null, completedAt: null, error: null, title: null, createdAt: new Date(), versionId: null, sourceType: "internal", sourceId: null, packageVersion: null, a2aTaskId: null, a2aContextId: null, parentRunId: null, agUiEnabled: null, lgThreadId: null, traceId: null, timeoutSeconds: null, streamedText: null, authPolicy: null }],
      total: 1,
    });
    authPolicyMock.enforceRunAccess.mockRejectedValueOnce(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    storeMock.resolveRunCoOwnerUserIds.mockResolvedValueOnce([]);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_list({
      primitiveName: "agent_run_list",
      input: { templateId: "t1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    // Empty-list semantics: denied rows are dropped, no error propagated.
    expect(result).toMatchObject({ items: [] });
    expect(result).not.toHaveProperty("error");
  });

  // -------------------------------------------------------------------------
  // Test 11 — RunList without templateId stays on readAgentRuns
  // -------------------------------------------------------------------------
  it("Test 11: RunList({}) (no templateId) calls readAgentRuns and returns the page", async () => {
    seedActiveOrg();
    storeMock.readAgentRuns.mockResolvedValueOnce({ items: [], total: 0 });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = await handlers.agent_run_list({
      primitiveName: "agent_run_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(storeMock.readAgentRuns).toHaveBeenCalled();
    expect(storeMock.readAgentRunsByTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ items: [] });
  });
});
