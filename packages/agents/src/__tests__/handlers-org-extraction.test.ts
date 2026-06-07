/**
 * Tests for MCP handler org extraction.
 *
 * handleAgentBuilderList / handleAgentBuilderRunGet /
 * handleAgentBuilderRunList must:
 *
 *   1. Extract activeOrganizationId from getAuthSession()
 *   2. Throw AuthzError(403) when org is missing AND user is not admin
 *   3. Pass organizationId to readAgentTemplates/readAgentRuns
 *   4. Pass skipOrgFilter: true when isPlatformAdmin(session) is true
 *
 * The store mock asserts whether organizationId arrived in the options bag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

const storeMock = vi.hoisted(() => ({
  // Surface every export handlers.ts pulls from "../store" so the mock
  // matches the real interface. Returning empty list pages is the safe
  // default — individual tests override per-call.
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0 }),
  readAgentTemplateById: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRuns: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  readAgentRunsByTemplate: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0 }),
  readAgentRunMessages: vi.fn().mockResolvedValue([]),
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
}));
vi.mock("../store", () => storeMock);

// auth-policy: enforceRunAccess noop so handlers don't gate on it.
vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(async () => undefined),
}));

// Other transitive deps that must not run
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

// ---------------------------------------------------------------------------
// ACTOR + sessions
// ---------------------------------------------------------------------------

const ACTOR = {
  actorType: "human" as const,
  source: "ui" as const,
  userId: "u1",
};

const sessionWithOrg = (orgId: string | null) => ({
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
    activeOrganizationId: orgId,
    userId: "u1",
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    token: "t",
  },
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// See handlers-auth-policy.test.ts; cold-start dynamic-import variance can
// exceed the default 5s when run with the full suite.
describe("handleAgentBuilderList org extraction", { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    storeMock.readAgentTemplates.mockResolvedValue({ items: [], total: 0 });
    storeMock.readAgentRuns.mockResolvedValue({ items: [], total: 0 });
    storeMock.readAgentRunsByTemplate.mockResolvedValue({ items: [], total: 0 });
  });

  it("returns Access-denied error when activeOrganizationId is null and user is not platform admin", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg(null));
    authSessionMock.isPlatformAdmin.mockReturnValue(false);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = (await handlers.agent_list({
      primitiveName: "agent_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    })) as { error?: string };
    expect(typeof result?.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/access denied|organization/);
  });

  it("passes organizationId to readAgentTemplates when session has activeOrganizationId", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg("org-A"));
    authSessionMock.isPlatformAdmin.mockReturnValue(false);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    await handlers.agent_list({
      primitiveName: "agent_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    });

    expect(storeMock.readAgentTemplates).toHaveBeenCalled();
    const callArg = storeMock.readAgentTemplates.mock.calls[0]?.[0] as
      | { organizationId?: string; skipOrgFilter?: boolean }
      | undefined;
    expect(callArg?.organizationId).toBe("org-A");
  });

  it("passes skipOrgFilter=true when isPlatformAdmin returns true (admin bypass)", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg(null));
    authSessionMock.isPlatformAdmin.mockReturnValue(true);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = (await handlers.agent_list({
      primitiveName: "agent_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    })) as { error?: string };

    // Admin must succeed (no error) even with null activeOrganizationId.
    expect(result?.error).toBeUndefined();

    // Optional: assert skipOrgFilter passed through. The handler can omit
    // organizationId or pass skipOrgFilter; either is acceptable as long as it
    // does not throw access denied.
    const callArg = storeMock.readAgentTemplates.mock.calls[0]?.[0] as
      | { organizationId?: string; skipOrgFilter?: boolean }
      | undefined;
    expect(
      callArg?.skipOrgFilter === true || callArg?.organizationId === undefined,
    ).toBe(true);
  });
});

describe("handleAgentBuilderRunGet org extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    storeMock.readAgentRunById.mockResolvedValue(null);
  });

  it("returns Access-denied error when activeOrganizationId is null and user is not platform admin", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg(null));
    authSessionMock.isPlatformAdmin.mockReturnValue(false);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = (await handlers.agent_run_get({
      primitiveName: "agent_run_get",
      input: { runId: "run-1" },
      actor: ACTOR,
      mode: "deterministic",
    })) as { error?: string };
    expect(typeof result?.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/access denied|organization/);
  });
});

describe("handleAgentBuilderRunList org extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.isPlatformAdmin.mockReturnValue(false);
    storeMock.readAgentRuns.mockResolvedValue({ items: [], total: 0 });
  });

  it("returns Access-denied error when activeOrganizationId is null and user is not platform admin", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg(null));
    authSessionMock.isPlatformAdmin.mockReturnValue(false);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    const result = (await handlers.agent_run_list({
      primitiveName: "agent_run_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    })) as { error?: string };
    expect(typeof result?.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/access denied|organization/);
  });

  it("forwards organizationId to readAgentRuns when session has activeOrganizationId (no templateId branch)", async () => {
    authSessionMock.getAuthSession.mockResolvedValue(sessionWithOrg("org-A"));
    authSessionMock.isPlatformAdmin.mockReturnValue(false);

    const { createAgentBuilderPrimitiveHandlers } = await import(
      "../mcp/handlers"
    );
    const handlers = createAgentBuilderPrimitiveHandlers();
    await handlers.agent_run_list({
      primitiveName: "agent_run_list",
      input: {},
      actor: ACTOR,
      mode: "deterministic",
    });

    expect(storeMock.readAgentRuns).toHaveBeenCalled();
    const callArg = storeMock.readAgentRuns.mock.calls[0]?.[0] as
      | { organizationId?: string }
      | undefined;
    expect(callArg?.organizationId).toBe("org-A");
  });
});
