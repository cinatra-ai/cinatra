// registry.uninstall gate on handleAgentBuilderDelete.
// Covers the expected behavior:
//   1. Non-org member -> "Access denied." (AuthzError 403 collapsed)
//   2. Org admin in same org -> succeeds (calls deleteAgentTemplate)
//   3. templateId not found -> "Template not found: ..." BEFORE auth gate

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Module mocks - only the dependencies exercised by handleAgentBuilderDelete
// ---------------------------------------------------------------------------

vi.mock("../store", () => ({
  readAgentTemplateById: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentTemplates: vi.fn(),
  updateAgentTemplate: vi.fn(),
  createAgentTemplate: vi.fn(),
  readAgentRunMessages: vi.fn(),
  readRunCoOwners: vi.fn().mockResolvedValue([]),
  updateAgentRun: vi.fn(),
  createAgentRun: vi.fn(),
  deleteAgentRun: vi.fn(),
  readAgentTemplatesByOrg: vi.fn(),
}));

vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(),
  actorContextFromMcpRequest: vi.fn(),
}));

vi.mock("@/lib/authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...original,
    can: vi.fn(),
    logAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn().mockResolvedValue(null),
  isPlatformAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn().mockResolvedValue([]),
  readProjectsForUser: vi.fn().mockResolvedValue([]),
}));

// Stub all other heavy deps that get pulled in via the handler module
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: vi.fn(), BACKGROUND_JOB_NAMES: {} }));
vi.mock("@/lib/mcp-pagination", () => ({ decodeCursor: vi.fn(() => 0), buildListPage: vi.fn((items: unknown) => items) }));
vi.mock("../trigger-service", () => ({ resolveTriggerConfig: vi.fn(), updateTriggerConfig: vi.fn(), deleteTriggerConfig: vi.fn(), triggerAgentManually: vi.fn() }));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("../verdaccio/client", () => ({ deleteAgentPackageVersion: vi.fn(), deprecateAgentPackageVersion: vi.fn(), publishAgentPackage: vi.fn(), publishAgentPackageFromGitDir: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("@cinatra-ai/skills", () => ({ upsertSkill: vi.fn(), parseFrontmatter: vi.fn(() => ({ frontmatter: {}, body: "" })) }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: vi.fn() }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleAgentBuilderDelete registry.uninstall gate", () => {
  let handlers: ReturnType<typeof import("../mcp/handlers").createAgentBuilderPrimitiveHandlers>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../mcp/handlers");
    handlers = mod.createAgentBuilderPrimitiveHandlers();
  });

  it("returns 'Template not found' before auth gate when template does not exist", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue(null);

    const result = await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "missing-id" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    expect(result).toMatchObject({ error: expect.stringContaining("Template not found: missing-id") });

    // can() must NOT have been called - 404 fires before auth gate
    const { can } = await import("@/lib/authz");
    expect(vi.mocked(can)).not.toHaveBeenCalled();
  });

  it("returns 'Access denied.' when actor is not an org member (can returns false)", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({ orgId: "org-1", id: "tpl-1" } as never);

    const { actorContextFromMcpRequest } = await import("../auth-policy");
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue({
      platformRole: "user",
      principalId: "u2",
      organizationId: "org-2", // different org
    } as never);

    const { can } = await import("@/lib/authz");
    vi.mocked(can).mockReturnValue(false); // non-member denied

    const result = await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-1" },
      actor: { userId: "u2", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    expect(result).toEqual({ error: "Access denied." });
    expect(vi.mocked(can)).toHaveBeenCalledWith(
      expect.anything(),
      "registry.uninstall",
      expect.objectContaining({ resourceType: "registry", resourceId: "tpl-1" }),
    );
  });

  it("proceeds to deleteAgentTemplate when actor is org admin (can returns true)", async () => {
    const { readAgentTemplateById, deleteAgentTemplate } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({ orgId: "org-1", id: "tpl-1" } as never);
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true as never);

    const { actorContextFromMcpRequest } = await import("../auth-policy");
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue({
      platformRole: "user",
      principalId: "u1",
      organizationId: "org-1",
    } as never);

    const { can } = await import("@/lib/authz");
    vi.mocked(can).mockReturnValue(true); // org admin allowed

    const result = await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-1" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    expect(result).toMatchObject({ templateId: "tpl-1", deleted: true });
    expect(vi.mocked(deleteAgentTemplate)).toHaveBeenCalledWith("tpl-1");
  });
});
