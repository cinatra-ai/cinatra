// Cross-org read gate on handleAgentBuilderGet (agent_get).
// Before this gate, agent_get performed NO authorization: any authenticated
// MCP caller who knew a template id could read ANY template (incl.
// agentAuthPolicy + schemas) across orgs. Covers:
//   1. Non-admin, no active org        -> "Active organization required." (before store read)
//   2. Non-admin, DIFFERENT org        -> "Template not found: ..." (404-hide, cross-org deny)
//   3. Non-admin, SAME org             -> template returned
//   4. Platform admin, different org   -> template returned (admin bypass)
//   5. templateId not found            -> "Template not found: ..." (org gate passed, row missing)

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Module mocks — same heavy-dep recipe as agent-builder-delete-auth.test.ts so
// the full handlers module loads; only readAgentTemplateById drives the cases.
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

// The cross-org gate lives in ../auth-policy (authorizeAgentTemplateRead), so
// keep the REAL module and stub only the unrelated run-authz exports the
// handler module also pulls in.
vi.mock("../auth-policy", async (importOriginal) => {
  const original = await importOriginal<typeof import("../auth-policy")>();
  return { ...original, enforceRunAccess: vi.fn(), actorContextFromMcpRequest: vi.fn() };
});

vi.mock("@/lib/authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...original,
    can: vi.fn(),
    logAuditEvent: vi.fn(),
  };
});

// getAuthSession/isPlatformAdmin are the FALLBACK for resolveOrgIdFromSession /
// resolveIsPlatformAdminFromSession — here they resolve to "no session"/"not
// admin", so the transport-verified actor envelope (actor.orgId /
// actor.platformRole) is authoritative in these tests.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn().mockResolvedValue(null),
  isPlatformAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  readTeamsForUser: vi.fn().mockResolvedValue([]),
  readProjectsForUser: vi.fn().mockResolvedValue([]),
}));

// Stub all other heavy deps that get pulled in via the handler module.
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
vi.mock("../agent-runtime-mount", () => ({ resolveAgentRuntimeMountDir: vi.fn(), resolveDevExtensionSourceRoot: vi.fn() }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VICTIM_TEMPLATE = {
  id: "tpl-victim",
  orgId: "org-victim",
  name: "Secret Agent",
  agentAuthPolicy: { runDataVisibility: "owner" },
  inputSchema: { type: "object" },
} as never;

const req = (
  input: Record<string, unknown>,
  actor: Record<string, unknown>,
) => ({
  primitiveName: "agent_get",
  input,
  actor: actor as unknown as PrimitiveActorContext,
  mode: "deterministic" as const,
});

describe("handleAgentBuilderGet cross-org read gate", () => {
  let handlers: ReturnType<typeof import("../mcp/handlers").createAgentBuilderPrimitiveHandlers>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../mcp/handlers");
    handlers = mod.createAgentBuilderPrimitiveHandlers();
  });

  it("DENIES a non-admin caller with no active org (before any store read)", async () => {
    const { readAgentTemplateById } = await import("../store");
    const result = await handlers["agent_get"](req({ templateId: "tpl-victim" }, { userId: "u1", source: "mcp" }));
    expect(result).toEqual({ error: "Active organization required." });
    // The store is never touched — the boundary denies first.
    expect(vi.mocked(readAgentTemplateById)).not.toHaveBeenCalled();
  });

  it("DENIES a cross-org caller as not-found (no existence disclosure)", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue(VICTIM_TEMPLATE);
    const result = (await handlers["agent_get"](
      req({ templateId: "tpl-victim" }, { userId: "attacker", source: "mcp", orgId: "org-attacker" }),
    )) as { error?: string; id?: string; agentAuthPolicy?: unknown };
    expect(result.error).toBe("Template not found: tpl-victim");
    expect(result.id).toBeUndefined();
    // The full template (incl. agentAuthPolicy) is NOT leaked.
    expect(result.agentAuthPolicy).toBeUndefined();
    // Denial is audited.
    const { logAuditEvent } = await import("@/lib/authz");
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "agent_template", resourceId: "tpl-victim", operation: "read", decision: "denied" }),
    );
  });

  it("ALLOWS a same-org caller (returns the full template)", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue(VICTIM_TEMPLATE);
    const result = (await handlers["agent_get"](
      req({ templateId: "tpl-victim" }, { userId: "member", source: "mcp", orgId: "org-victim" }),
    )) as { id?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.id).toBe("tpl-victim");
  });

  it("ALLOWS a platform admin from a different org (admin bypass)", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue(VICTIM_TEMPLATE);
    const result = (await handlers["agent_get"](
      req({ templateId: "tpl-victim" }, { userId: "root", source: "mcp", orgId: "org-other", platformRole: "platform_admin" }),
    )) as { id?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.id).toBe("tpl-victim");
  });

  it("returns 'Template not found' for a missing template (org gate passed)", async () => {
    const { readAgentTemplateById } = await import("../store");
    vi.mocked(readAgentTemplateById).mockResolvedValue(null as never);
    const result = (await handlers["agent_get"](
      req({ templateId: "ghost" }, { userId: "member", source: "mcp", orgId: "org-victim" }),
    )) as { error?: string };
    expect(result.error).toBe("Template not found: ghost");
  });
});
