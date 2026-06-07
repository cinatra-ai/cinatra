/**
 * Integration tests for the WayFlow preflight branch in
 * `handleAgentBuilderRun`. The unit-level coverage of `preflightWayflowAgent`
 * lives in `wayflow-preflight.test.ts` — this file exercises the handler's
 * decision to short-circuit or proceed based on the preflight result.
 *
 * Cases:
 *   1. `WAYFLOW_AGENT_NOT_REGISTERED` → short-circuit, no createAgentRun,
 *      no enqueueBackgroundJob, structured error returned.
 *   2. `WAYFLOW_NOT_CONFIGURED` → short-circuit, no createAgentRun, no
 *      enqueue, structured error returned.
 *   3. `PREFLIGHT_UNAVAILABLE` → proceed; createAgentRun + enqueue happen.
 *   4. `OK` → proceed; createAgentRun + enqueue happen.
 *   5. External template (sourceType: "external") → preflight skipped
 *      entirely (no fetch attempted); proceed with dispatch.
 *   6. Template without packageName → preflight skipped; proceed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_WITH_ORG = {
  user: { id: "owner-1", role: "user", email: "owner@example.com" },
  session: { id: "sess-1", activeOrganizationId: "org-1" },
};

const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

const storeMock = vi.hoisted(() => ({
  readAgentTemplateById: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(),
  countAgentRunsByTemplate: vi.fn(),
  updateAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  countAgentTemplates: vi.fn(),
  setAgentTemplatePackageName: vi.fn(),
  readAgentVersionById: vi.fn(),
  insertAgentVersion: vi.fn(),
  setActiveAgentVersion: vi.fn(),
  setActiveAgentVersionWithApprovalPolicy: vi.fn(),
  updateAgentTemplate: vi.fn(),
  updateAgentTemplateOrigin: vi.fn(),
  upsertAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  countAgentVersions: vi.fn(),
  readAgentRunMessages: vi.fn(),
  insertAgentRunMessage: vi.fn(),
  countAgentRunMessages: vi.fn(),
  deleteAgentRunMessagesForRun: vi.fn(),
  deleteAgentRunsForTemplate: vi.fn(),
  countAgentRunsForTemplates: vi.fn(() => new Map()),
}));
vi.mock("../store", () => storeMock);

const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined),
  resolveEffectivePolicy: vi.fn(() => ({})),
}));
vi.mock("../auth-policy", () => authPolicyMock);

const authzMock = vi.hoisted(() => ({
  logAuditEvent: vi.fn(() => Promise.resolve()),
  POLICY_VERSION: "test",
  AuthzError: class AuthzError extends Error {},
  resolveRoleHintsFromSession: vi.fn(async () => ({ teamIds: [], projectIds: [] })),
  resolveOrgIdFromSession: vi.fn(async () => "org-1"),
  resolveIsPlatformAdminFromSession: vi.fn(async () => false),
  authzErrorToResponse: vi.fn(),
  enforceListItemAccess: vi.fn(),
}));
vi.mock("@/lib/authz", () => authzMock);

const preflightMock = vi.hoisted(() => ({
  preflightWayflowAgent: vi.fn(),
}));
vi.mock("../wayflow-preflight", () => preflightMock);

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
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => { throw new Error("not used"); },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn((p: unknown) => p) }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));
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

import { enqueueBackgroundJob } from "@/lib/background-jobs";

function seedInternalTemplate(packageName: string | null = "@cinatra/uat-test"): void {
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
    packageName,
    executionProvider: "wayflow",
    type: "flow",
  });
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
}

function seedSession(): void {
  authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
  authSessionMock.isPlatformAdmin.mockReturnValue(false);
}

describe("handleAgentBuilderRun — WayFlow preflight integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedSession();
    authPolicyMock.enforceRunAccess.mockImplementation(async () => undefined);
    authzMock.resolveOrgIdFromSession.mockResolvedValue("org-1");
    authzMock.resolveIsPlatformAdminFromSession.mockResolvedValue(false);
    authzMock.resolveRoleHintsFromSession.mockResolvedValue({ teamIds: [], projectIds: [] });
  });

  it("short-circuits on WAYFLOW_AGENT_NOT_REGISTERED — no run created, no job enqueued", async () => {
    seedInternalTemplate("@cinatra/freshly-published-agent");
    preflightMock.preflightWayflowAgent.mockResolvedValue({
      code: "WAYFLOW_AGENT_NOT_REGISTERED",
      error: "Agent '@cinatra/freshly-published-agent' is published but not registered with WayFlow…",
      packageName: "@cinatra/freshly-published-agent",
      expectedUrl: "http://localhost:3010/extensions/cinatra-ai/freshly-published-agent/.well-known/agent-card.json",
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({
      code: "WAYFLOW_AGENT_NOT_REGISTERED",
      packageName: "@cinatra/freshly-published-agent",
    });
    expect(storeMock.createAgentRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("short-circuits on WAYFLOW_NOT_CONFIGURED — no run created, no job enqueued", async () => {
    seedInternalTemplate("@cinatra/some-agent");
    preflightMock.preflightWayflowAgent.mockResolvedValue({
      code: "WAYFLOW_NOT_CONFIGURED",
      error: "WayFlow is not configured…",
      reason: "WAYFLOW_BASE_URL is not set",
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ code: "WAYFLOW_NOT_CONFIGURED" });
    expect(storeMock.createAgentRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("proceeds normally when preflight returns OK", async () => {
    seedInternalTemplate("@cinatra/some-agent");
    preflightMock.preflightWayflowAgent.mockResolvedValue({ code: "OK" });

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
  });

  it("proceeds normally when preflight returns PREFLIGHT_UNAVAILABLE (transient probe failure)", async () => {
    seedInternalTemplate("@cinatra/some-agent");
    preflightMock.preflightWayflowAgent.mockResolvedValue({
      code: "PREFLIGHT_UNAVAILABLE",
      reason: "connect ECONNREFUSED 127.0.0.1:3010",
    });

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(storeMock.createAgentRun).toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalled();
  });

  it("skips preflight entirely for external templates (sourceType: 'external')", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-ext",
      name: "External A2A Agent",
      agentAuthPolicy: {
        runListVisibility: "owner",
        runDataVisibility: "owner",
        runExecuteVisibility: "owner",
        allowRunSharing: false,
      },
      status: "published",
      sourceType: "external",
      packageName: "@external/some-agent",
      executionProvider: "wayflow",
      type: "flow",
    });
    storeMock.readAgentVersionsByTemplate.mockResolvedValue([{ id: "ver-1" }]);
    storeMock.createAgentRun.mockResolvedValue({
      id: "run-ext",
      templateId: "tpl-ext",
      status: "queued",
      runBy: "owner-1",
      orgId: "org-1",
      inputParams: {},
      createdAt: new Date(),
      versionId: null,
      sourceType: "external",
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

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-ext" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(preflightMock.preflightWayflowAgent).not.toHaveBeenCalled();
    expect(storeMock.createAgentRun).toHaveBeenCalled();
  });

  it("skips preflight when template has no packageName (legacy / DB-only templates)", async () => {
    seedInternalTemplate(null);

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();

    const result = await handlers.agent_run({
      primitiveName: "agent_run",
      input: { templateId: "tpl-1" },
      actor: { actorType: "model", source: "agent", userId: "owner-1" },
      mode: "deterministic",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(preflightMock.preflightWayflowAgent).not.toHaveBeenCalled();
    expect(storeMock.createAgentRun).toHaveBeenCalled();
  });
});
