import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Viewed-org management gate (cinatra#1510). The RBAC visibility matrix is
// asserted HERE, at the authoritative gate: the role resolved from the VIEWED
// org is mapped through the REAL permission catalog (policies.ts is NOT mocked),
// so these tests lock the catalog-truth mapping the ruling's "where permitted"
// clause requires.
//
// Mocked: `resolveOrgRoleForUser` (the per-request membership lookup), the
// single-org toggle, and the org-row slug read (the two structural inputs of
// `canDelete`). Everything else is the production code path.
// ---------------------------------------------------------------------------

const resolveOrgRoleForUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

const isSingleOrgMode = vi.fn();
vi.mock("@/lib/authz/instance-mode", () => ({
  isSingleOrgMode: (...a: unknown[]) => isSingleOrgMode(...a),
}));

// The org-row slug read: a REAL minimal pgTable (so the gate's `eq()` builds a
// genuine drizzle expression) + a select chain resolving to controllable rows.
const orgRowsResult = vi.fn<() => Promise<Array<{ slug: string | null }>>>();
vi.mock("@/lib/better-auth-db", async () => {
  const { pgTable, text } = await import("drizzle-orm/pg-core");
  return {
    betterAuthOrganizations: pgTable("organization", {
      id: text("id").primaryKey(),
      slug: text("slug"),
    }),
    betterAuthDb: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => orgRowsResult() }),
        }),
      }),
    },
  };
});

import {
  resolveOrganizationManageCapabilities,
  userCanManageOrganization,
  userCanManageOrganizationMembers,
} from "@/lib/authz/organization-manage-gate";

const SESSION = { user: { id: "user_1" }, session: { activeOrganizationId: "other_org" } };
const ORG = "org_viewed";

beforeEach(() => {
  resolveOrgRoleForUser.mockReset();
  isSingleOrgMode.mockReset();
  orgRowsResult.mockReset();
  // Default structural state: multi-org mode, a non-default org row present.
  isSingleOrgMode.mockResolvedValue(false);
  orgRowsResult.mockResolvedValue([{ slug: "acme" }]);
});

describe("resolveOrganizationManageCapabilities — RBAC matrix (catalog truth)", () => {
  it("org_owner: manages settings AND members AND may delete (catalog + structural)", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_owner");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({
      role: "org_owner",
      canManageSettings: true,
      canManageMembers: true,
      canDelete: true,
    });
    // Resolved against the VIEWED org, not the active org.
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith(ORG, "user_1");
  });

  it("org_admin: settings ONLY — no member management, no delete, and NO structural reads", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_admin");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({
      role: "org_admin",
      canManageSettings: true,
      canManageMembers: false,
      canDelete: false,
    });
    // Only a role holding organization.delete pays the structural lookups.
    expect(isSingleOrgMode).not.toHaveBeenCalled();
    expect(orgRowsResult).not.toHaveBeenCalled();
  });

  it("member: read-only — no management at all", async () => {
    resolveOrgRoleForUser.mockResolvedValue("member");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({
      role: "member",
      canManageSettings: false,
      canManageMembers: false,
      canDelete: false,
    });
  });

  it("non-member (role undefined): no capabilities — NO platform_admin synthesis", async () => {
    // A platform admin who is not a member of THIS org resolves to undefined,
    // exactly like any other non-member: organization CRUD is granted only by
    // the viewed-org membership role, never by platform role.
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({
      role: undefined,
      canManageSettings: false,
      canManageMembers: false,
      canDelete: false,
    });
  });

  it("no session / no user id: fail-closed WITHOUT a membership lookup", async () => {
    const caps = await resolveOrganizationManageCapabilities(null, ORG);
    expect(caps).toEqual({
      role: undefined,
      canManageSettings: false,
      canManageMembers: false,
      canDelete: false,
    });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("missing org id: fail-closed WITHOUT a membership lookup", async () => {
    const caps = await resolveOrganizationManageCapabilities(SESSION, "");
    expect(caps).toEqual({
      role: undefined,
      canManageSettings: false,
      canManageMembers: false,
      canDelete: false,
    });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("lookup error: fail-closed (never throws)", async () => {
    resolveOrgRoleForUser.mockRejectedValue(new Error("db down"));
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({
      role: undefined,
      canManageSettings: false,
      canManageMembers: false,
      canDelete: false,
    });
  });
});

describe("canDelete — structural hazards (org_owner holds the catalog permission)", () => {
  beforeEach(() => {
    resolveOrgRoleForUser.mockResolvedValue("org_owner");
  });

  it("default org (slug='default'): NOT deletable — the bootstrap recreates it (hazard 1)", async () => {
    orgRowsResult.mockResolvedValue([{ slug: "default" }]);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps.canDelete).toBe(false);
    // Everything else stays intact — the structural block narrows ONLY delete.
    expect(caps.canManageMembers).toBe(true);
  });

  it("single-org mode: NOT deletable (hazard 3)", async () => {
    isSingleOrgMode.mockResolvedValue(true);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps.canDelete).toBe(false);
  });

  it("org row missing: fail-closed", async () => {
    orgRowsResult.mockResolvedValue([]);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps.canDelete).toBe(false);
  });

  it("structural read error: fail-closed (never throws)", async () => {
    orgRowsResult.mockRejectedValue(new Error("db down"));
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps.canDelete).toBe(false);
    expect(caps.canManageSettings).toBe(true);
  });

  it("NULL slug (no slug yet): deletable — only the literal 'default' slug is the bootstrap org", async () => {
    orgRowsResult.mockResolvedValue([{ slug: null }]);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps.canDelete).toBe(true);
  });
});

describe("thin wrappers", () => {
  it("userCanManageOrganization is true for org_admin+ only", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_admin");
    await expect(userCanManageOrganization(SESSION, ORG)).resolves.toBe(true);
    resolveOrgRoleForUser.mockResolvedValue("member");
    await expect(userCanManageOrganization(SESSION, ORG)).resolves.toBe(false);
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    await expect(userCanManageOrganization(SESSION, ORG)).resolves.toBe(false);
  });

  it("userCanManageOrganizationMembers is true for org_owner only", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_owner");
    await expect(userCanManageOrganizationMembers(SESSION, ORG)).resolves.toBe(true);
    resolveOrgRoleForUser.mockResolvedValue("org_admin");
    await expect(userCanManageOrganizationMembers(SESSION, ORG)).resolves.toBe(false);
    resolveOrgRoleForUser.mockResolvedValue("member");
    await expect(userCanManageOrganizationMembers(SESSION, ORG)).resolves.toBe(false);
  });
});
