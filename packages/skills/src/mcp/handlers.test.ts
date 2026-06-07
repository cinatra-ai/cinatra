/**
 * Regression coverage for agent-level skill listing.
 *
 * The `libraryListSchema.level` enum includes `"agent"` so the
 * `skills_library_list` MCP primitive can return only level:"agent" rows.
 * Without this test, a future refactor that drops the value would silently
 * break declarative agent-skill resolution. The full primitive handler is
 * exercised by integration tests; this suite asserts only the Zod schema
 * shape, which is the minimum surface needed to prevent the regression.
 *
 * Visibility filter integration tests cover skills_installed_list and
 * skills_installed_get. They assert that the handlers enforce
 * requireResourceAccess guards for installed skill rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock the skills-store, personal-skills, skills-registry, github, and
// the @/lib/* modules so handlers.ts can be imported without pulling in
// any DB/network/server-only modules. Only `libraryListSchema` is exercised.
vi.mock("../skills-store", () => ({
  readSkillsCatalog: vi.fn(),
  uninstallSkillPackage: vi.fn(),
  listCustomSkills: vi.fn(),
  getCustomSkillById: vi.fn(),
  upsertCustomSkill: vi.fn(),
  upsertSkill: vi.fn(),
  deleteCustomSkill: vi.fn(),
  listCustomSkillsForAgent: vi.fn(),
}));
vi.mock("../personal-skills", () => ({
  createOrUpdateCustomSkillForAgent: vi.fn(),
  resolveCustomSkillContent: vi.fn(),
}));
vi.mock("../skills-registry", () => ({
  getInstalledSkillById: vi.fn(),
  listInstalledSkills: vi.fn(),
  listInstalledSkillPackages: vi.fn(),
  parseFrontmatter: vi.fn(),
}));
vi.mock("../github", () => ({
  installSkillPackageFromGitHub: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(),
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn((items: unknown[]) => ({ items, total: items.length })),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn().mockResolvedValue([]),
  readProjectsForUser: vi.fn().mockResolvedValue([]),
}));

// Match the import path actually used by handlers.ts
// (`@cinatra-ai/agents/auth-policy`). The
// `@cinatra/agent-builder/auth-policy` mock path is stale and does not
// intercept the real module, leaving `actorContextFromMcpRequest` as the
// real implementation (which makes `vi.mocked(...).mockResolvedValue` throw
// "is not a function" and breaks visibility tests).
vi.mock("@cinatra-ai/agents/auth-policy", () => ({
  requireResourceAccess: vi.fn(),
  actorContextFromMcpRequest: vi.fn(),
}));

import { libraryListSchema, createSkillsPrimitiveHandlers } from "./handlers";

describe("libraryListSchema — agent-level regression", () => {
  it("accepts level: 'agent'", () => {
    expect(() => libraryListSchema.parse({ level: "agent" })).not.toThrow();
  });

  it("accepts level: 'personal'", () => {
    expect(() => libraryListSchema.parse({ level: "personal" })).not.toThrow();
  });

  it("accepts level: 'team'", () => {
    expect(() => libraryListSchema.parse({ level: "team" })).not.toThrow();
  });

  it("accepts level: 'organization'", () => {
    expect(() => libraryListSchema.parse({ level: "organization" })).not.toThrow();
  });

  // "third-party" is intentionally absent from the enum; assert rejection
  // so the regression is locked in.
  it("rejects level: 'third-party'", () => {
    expect(() => libraryListSchema.parse({ level: "third-party" })).toThrow();
  });

  it("rejects level: 'bogus'", () => {
    expect(() => libraryListSchema.parse({ level: "bogus" })).toThrow();
  });

  it("accepts an empty input (level is optional)", () => {
    expect(() => libraryListSchema.parse({})).not.toThrow();
  });

  it("includes 'agent' in its enum members", () => {
    // Defensive check that the enum literally contains the agent-level entry. If
    // someone removes "agent" from the enum, both the parse-success test
    // above and this assertion will fail in tandem, making the regression
    // unmissable.
    const parsed = libraryListSchema.safeParse({ level: "agent" });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Visibility filter integration tests
// ---------------------------------------------------------------------------
// Strategy: mock requireResourceAccess to simulate the kernel throwing AuthzError
// for system/out-of-team rows, then assert the handler filters them out.
// ---------------------------------------------------------------------------

describe("skills_installed_list — visibility filter", () => {
  // Canned skills rows used across tests
  const systemSkill = { id: "sys-1", name: "System Skill", level: "system", scope: null };
  const orgSkill = { id: "org-1", name: "Org Skill", level: "organization", scope: "org-1" };
  const orgOtherSkill = { id: "org-2", name: "Other Org Skill", level: "organization", scope: "org-2" };
  const teamT1Skill = { id: "team-t1", name: "Team T1 Skill", level: "team", scope: "t1" };
  const teamT2Skill = { id: "team-t2", name: "Team T2 Skill", level: "team", scope: "t2" };
  const personalSkill = { id: "personal-1", name: "Personal Skill", level: "personal", scope: "u1" };

  const allSkillRows = [systemSkill, orgSkill, orgOtherSkill, teamT1Skill, teamT2Skill, personalSkill];

  beforeEach(async () => {
    const { listInstalledSkills } = await import("../skills-registry");
    vi.mocked(listInstalledSkills).mockResolvedValue(allSkillRows as never);
  });

  it("non-admin actor: excludes system-level and out-of-org/out-of-team rows, includes personal + own-org + own-team", async () => {
    // Set up: requireResourceAccess throws for system/other-org/other-team rows
    const { requireResourceAccess, actorContextFromMcpRequest } = await import("@cinatra-ai/agents/auth-policy");
    const fakeActorCtx = { platformRole: "user", principalId: "u1", organizationId: "org-1", teamIds: ["t1"] };
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue(fakeActorCtx as never);

    const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
    vi.mocked(getAuthSession).mockResolvedValue({ session: { activeOrganizationId: "org-1" } } as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    vi.mocked(requireResourceAccess).mockImplementation((_actor, resource) => {
      if (resource.level === "system") throw new Error("hidden");
      // org-level: ownerId is the skill's scope (organization id that owns the skill)
      if (resource.level === "organization" && resource.ownerId !== "org-1") throw new Error("forbidden");
      if (resource.level === "team" && resource.ownerId !== "t1") throw new Error("forbidden");
      // otherwise allow
    });

    const handlers = createSkillsPrimitiveHandlers();
    const result = await handlers["skills_installed_list"]({ primitiveName: "skills_installed_list", input: {}, actor: { userId: "u1", source: "ui" } } as never) as { items: Array<{ id: string }> };

    const ids = result.items.map((s) => s.id);
    expect(ids).not.toContain("sys-1");        // system — excluded
    expect(ids).not.toContain("org-2");        // other org — excluded
    expect(ids).not.toContain("team-t2");      // other team — excluded
    expect(ids).toContain("org-1");            // own org — included
    expect(ids).toContain("team-t1");          // own team — included
    expect(ids).toContain("personal-1");       // personal — included
  });

  it("platform admin: sees all rows including system-level", async () => {
    const { requireResourceAccess, actorContextFromMcpRequest } = await import("@cinatra-ai/agents/auth-policy");
    const fakeAdminCtx = { platformRole: "platform_admin", principalId: "admin-1", organizationId: "org-1" };
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue(fakeAdminCtx as never);

    const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
    vi.mocked(getAuthSession).mockResolvedValue({ session: { activeOrganizationId: "org-1" } } as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(true);

    // Admin: requireResourceAccess never throws
    vi.mocked(requireResourceAccess).mockImplementation(() => undefined);

    const handlers = createSkillsPrimitiveHandlers();
    const result = await handlers["skills_installed_list"]({ primitiveName: "skills_installed_list", input: {}, actor: { userId: "admin-1", source: "ui" } } as never) as { items: Array<{ id: string }> };

    const ids = result.items.map((s) => s.id);
    expect(ids).toContain("sys-1");    // admin sees system rows
    expect(ids).toContain("org-1");
    expect(ids).toContain("org-2");
    expect(ids).toContain("team-t1");
    expect(ids).toContain("team-t2");
    expect(ids).toContain("personal-1");
  });

  it("non-admin in team t1: sees t1 team skill but not t2 team skill", async () => {
    const { requireResourceAccess, actorContextFromMcpRequest } = await import("@cinatra-ai/agents/auth-policy");
    const fakeCtx = { platformRole: "user", principalId: "u1", organizationId: "org-1", teamIds: ["t1"] };
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue(fakeCtx as never);

    const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
    vi.mocked(getAuthSession).mockResolvedValue({ session: { activeOrganizationId: "org-1" } } as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    vi.mocked(requireResourceAccess).mockImplementation((_actor, resource) => {
      if (resource.level === "system") throw new Error("hidden");
      if (resource.level === "team" && resource.ownerId === "t2") throw new Error("forbidden");
    });

    const handlers = createSkillsPrimitiveHandlers();
    const result = await handlers["skills_installed_list"]({ primitiveName: "skills_installed_list", input: {}, actor: { userId: "u1", source: "ui" } } as never) as { items: Array<{ id: string }> };

    const ids = result.items.map((s) => s.id);
    expect(ids).toContain("team-t1");
    expect(ids).not.toContain("team-t2");
  });
});

describe("skills_installed_get — visibility filter", () => {
  it("non-admin: system-level skill returns null (404 semantics)", async () => {
    const { requireResourceAccess, actorContextFromMcpRequest } = await import("@cinatra-ai/agents/auth-policy");
    const systemSkillRow = { id: "sys-1", name: "Sys", level: "system", scope: null, content: "# Sys", sourcePath: null, packageName: null, basedOnSkillId: null };
    const { getInstalledSkillById } = await import("../skills-registry");
    vi.mocked(getInstalledSkillById).mockResolvedValue(systemSkillRow as never);

    const fakeCtx = { platformRole: "user", principalId: "u1", organizationId: "org-1" };
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue(fakeCtx as never);

    const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
    vi.mocked(getAuthSession).mockResolvedValue({ session: { activeOrganizationId: "org-1" } } as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    // Simulate AuthzError from requireResourceAccess for system skill.
    // Import real AuthzError (not mocked) so instanceof check in handler works.
    const { AuthzError: RealAuthzError } = await import("@/lib/authz");
    vi.mocked(requireResourceAccess).mockImplementation((_actor, resource) => {
      if (resource.level === "system") {
        throw new RealAuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }
    });

    // Also mock parseFrontmatter since it may be called after auth check in production
    const { parseFrontmatter } = await import("../skills-registry");
    vi.mocked(parseFrontmatter).mockReturnValue({ frontmatter: {}, body: "" } as never);

    const handlers = createSkillsPrimitiveHandlers();
    const result = await handlers["skills_installed_get"]({ primitiveName: "skills_installed_get", input: { skillId: "sys-1" }, actor: { userId: "u1", source: "ui" } } as never);

    expect(result).toBeNull();
  });

  it("platform admin: system-level skill returns the skill object", async () => {
    const { requireResourceAccess, actorContextFromMcpRequest } = await import("@cinatra-ai/agents/auth-policy");
    const systemSkillRow = { id: "sys-1", name: "Sys", level: "system", scope: null, content: "# Sys", sourcePath: null, packageName: null, basedOnSkillId: null };
    const { getInstalledSkillById } = await import("../skills-registry");
    vi.mocked(getInstalledSkillById).mockResolvedValue(systemSkillRow as never);

    const fakeAdminCtx = { platformRole: "platform_admin", principalId: "admin-1" };
    vi.mocked(actorContextFromMcpRequest).mockResolvedValue(fakeAdminCtx as never);

    const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
    vi.mocked(getAuthSession).mockResolvedValue({ session: { activeOrganizationId: "org-1" } } as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(true);

    // Admin: requireResourceAccess never throws
    vi.mocked(requireResourceAccess).mockImplementation(() => undefined);

    const { parseFrontmatter } = await import("../skills-registry");
    vi.mocked(parseFrontmatter).mockReturnValue({ frontmatter: {}, body: "content" } as never);

    const handlers = createSkillsPrimitiveHandlers();
    const result = await handlers["skills_installed_get"]({ primitiveName: "skills_installed_get", input: { skillId: "sys-1" }, actor: { userId: "admin-1", source: "ui" } } as never);

    expect(result).not.toBeNull();
    expect((result as { id: string }).id).toBe("sys-1");
  });
});
