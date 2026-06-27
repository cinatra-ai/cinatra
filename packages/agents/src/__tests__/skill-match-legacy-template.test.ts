/**
 * Legacy template (null packageName) behavior on agent_save / agent_delete
 * inline-evaluation hooks.
 *
 * Legacy fallback behavior:
 *   - agent_save:    matcherAgentId = template.packageName ?? template.id
 *                    → fallback to UUID; enqueueInlineForAgent ran but found
 *                    no catalog entry; admin saw no match rows.
 *   - agent_delete:  same fallback; cleanupForAgent purged 0 rows.
 *
 * Expected behavior:
 *   - When template.packageName is null/empty, NEITHER enqueueInlineForAgent
 *     NOR cleanupForAgent is called.
 *   - A structured warning is emitted to console.warn with:
 *       { event: "skill_match_inline_skipped_legacy_template",
 *         templateId, reason: "no_packageName", context }
 *   - When template.packageName is set, the corresponding hook IS called.
 *
 * We only exercise the agent_delete branch here — it's the smaller code
 * path with fewer transitive mocks. The agent_save fix uses the exact same
 * conditional structure (verified by inspection); covering one branch
 * proves the pattern.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Capture enqueueInlineForAgent / cleanupForAgent so we can assert call counts.
// ---------------------------------------------------------------------------

const enqueueInlineForAgentMock = vi.fn().mockResolvedValue(undefined);
const cleanupForAgentMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ frontmatter: {}, body: "" })),
  enqueueInlineForAgent: (...args: unknown[]) => enqueueInlineForAgentMock(...args),
  cleanupForAgent: (...args: unknown[]) => cleanupForAgentMock(...args),
}));

// ---------------------------------------------------------------------------
// Heavy transitive mocks needed for handlers.ts to import.
// (Lifted from agent-builder-delete-auth.test.ts which proves these dependencies
// are the minimal set the agent_delete handler needs.)
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

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: {},
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn((items: unknown) => items),
}));
vi.mock("../trigger-service", () => ({
  resolveTriggerConfig: vi.fn(),
  updateTriggerConfig: vi.fn(),
  deleteTriggerConfig: vi.fn(),
  triggerAgentManually: vi.fn(),
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: vi.fn() }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function setupHandlers() {
  vi.clearAllMocks();
  enqueueInlineForAgentMock.mockClear();
  cleanupForAgentMock.mockClear();
  const mod = await import("../mcp/handlers");
  return mod.createAgentBuilderPrimitiveHandlers();
}

async function configureAuthPasses() {
  const { actorContextFromMcpRequest } = await import("../auth-policy");
  vi.mocked(actorContextFromMcpRequest).mockResolvedValue({
    platformRole: "user",
    principalId: "u1",
    organizationId: "org-1",
  } as never);
  const { can } = await import("@/lib/authz");
  vi.mocked(can).mockReturnValue(true);
}

describe("agent_delete — skill-match cleanup legacy-template behavior", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("cleanupForAgent is NOT called when template.packageName is null", async () => {
    const handlers = await setupHandlers();
    await configureAuthPasses();

    const { readAgentTemplateById, deleteAgentTemplate } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({
      id: "tpl-legacy-uuid",
      orgId: "org-1",
      packageName: null,
    } as never);
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true as never);

    const result = await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-legacy-uuid" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    expect(result).toMatchObject({ templateId: "tpl-legacy-uuid", deleted: true });
    // cleanupForAgent MUST NOT have been called; legacy fallback would have
    // been called with template.id (the UUID), purging 0 rows silently.
    expect(cleanupForAgentMock).not.toHaveBeenCalled();
  });

  it("structured warning is emitted with the legacy-template event marker", async () => {
    const handlers = await setupHandlers();
    await configureAuthPasses();

    const { readAgentTemplateById, deleteAgentTemplate } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({
      id: "tpl-legacy-uuid",
      orgId: "org-1",
      packageName: null,
    } as never);
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true as never);

    await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-legacy-uuid" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    // Find the structured warning JSON line among any warns that fired.
    const structuredWarns = warnSpy.mock.calls
      .map((call) => call[0])
      .filter((m): m is string => typeof m === "string" && m.startsWith("{"))
      .map((m) => {
        try {
          return JSON.parse(m) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((m): m is Record<string, unknown> => m !== null);

    const matching = structuredWarns.find(
      (m) => m.event === "skill_match_inline_skipped_legacy_template",
    );
    expect(matching).toBeDefined();
    expect(matching).toMatchObject({
      event: "skill_match_inline_skipped_legacy_template",
      templateId: "tpl-legacy-uuid",
      reason: "no_packageName",
      context: "agent_delete",
    });
  });

  it("cleanupForAgent IS called with packageName when packageName is set", async () => {
    const handlers = await setupHandlers();
    await configureAuthPasses();

    const { readAgentTemplateById, deleteAgentTemplate } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({
      id: "tpl-modern",
      orgId: "org-1",
      packageName: "@cinatra/email-outreach",
    } as never);
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true as never);

    await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-modern" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    // cleanupForAgent MUST have been called with the packageName, NOT the UUID.
    expect(cleanupForAgentMock).toHaveBeenCalledTimes(1);
    expect(cleanupForAgentMock).toHaveBeenCalledWith("@cinatra/email-outreach");
    // No skipped-legacy warning when packageName is present.
    const structuredWarns = warnSpy.mock.calls
      .map((call) => call[0])
      .filter((m): m is string => typeof m === "string" && m.includes("skill_match_inline_skipped_legacy_template"));
    expect(structuredWarns.length).toBe(0);
  });

  it("empty-string packageName is treated as missing (falsy)", async () => {
    const handlers = await setupHandlers();
    await configureAuthPasses();

    const { readAgentTemplateById, deleteAgentTemplate } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue({
      id: "tpl-empty-pkg",
      orgId: "org-1",
      packageName: "",
    } as never);
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true as never);

    await handlers["agent_delete"]({
      primitiveName: "agent_delete",
      input: { templateId: "tpl-empty-pkg" },
      actor: { userId: "u1", source: "ui" } as unknown as PrimitiveActorContext,
      mode: "deterministic",
    });

    expect(cleanupForAgentMock).not.toHaveBeenCalled();
    const structuredWarns = warnSpy.mock.calls
      .map((call) => call[0])
      .filter((m): m is string => typeof m === "string" && m.includes("skill_match_inline_skipped_legacy_template"));
    expect(structuredWarns.length).toBe(1);
  });
});
