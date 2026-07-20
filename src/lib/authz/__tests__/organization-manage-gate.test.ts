import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Viewed-org management gate (cinatra#1510). The RBAC visibility matrix is
// asserted HERE, at the authoritative gate: the role resolved from the VIEWED
// org is mapped through the REAL permission catalog (policies.ts is NOT mocked),
// so these tests lock the catalog-truth mapping the ruling's "where permitted"
// clause requires.
//
// Only `resolveOrgRoleForUser` is mocked (the per-request membership lookup);
// everything else is the production code path.
// ---------------------------------------------------------------------------

const resolveOrgRoleForUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

import {
  resolveOrganizationManageCapabilities,
  userCanManageOrganization,
  userCanManageOrganizationMembers,
} from "@/lib/authz/organization-manage-gate";

const SESSION = { user: { id: "user_1" }, session: { activeOrganizationId: "other_org" } };
const ORG = "org_viewed";

beforeEach(() => {
  resolveOrgRoleForUser.mockReset();
});

describe("resolveOrganizationManageCapabilities — RBAC matrix (catalog truth)", () => {
  it("org_owner: manages settings AND members (organization.update + manageMembers)", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_owner");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({ role: "org_owner", canManageSettings: true, canManageMembers: true });
    // Resolved against the VIEWED org, not the active org.
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith(ORG, "user_1");
  });

  it("org_admin: settings ONLY — no member management (catalog narrows manageMembers to owner)", async () => {
    resolveOrgRoleForUser.mockResolvedValue("org_admin");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({ role: "org_admin", canManageSettings: true, canManageMembers: false });
  });

  it("member: read-only — no management at all", async () => {
    resolveOrgRoleForUser.mockResolvedValue("member");
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({ role: "member", canManageSettings: false, canManageMembers: false });
  });

  it("non-member (role undefined): no capabilities — NO platform_admin synthesis", async () => {
    // A platform admin who is not a member of THIS org resolves to undefined,
    // exactly like any other non-member: organization CRUD is granted only by
    // the viewed-org membership role, never by platform role.
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({ role: undefined, canManageSettings: false, canManageMembers: false });
  });

  it("no session / no user id: fail-closed WITHOUT a membership lookup", async () => {
    const caps = await resolveOrganizationManageCapabilities(null, ORG);
    expect(caps).toEqual({ role: undefined, canManageSettings: false, canManageMembers: false });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("missing org id: fail-closed WITHOUT a membership lookup", async () => {
    const caps = await resolveOrganizationManageCapabilities(SESSION, "");
    expect(caps).toEqual({ role: undefined, canManageSettings: false, canManageMembers: false });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("lookup error: fail-closed (never throws)", async () => {
    resolveOrgRoleForUser.mockRejectedValue(new Error("db down"));
    const caps = await resolveOrganizationManageCapabilities(SESSION, ORG);
    expect(caps).toEqual({ role: undefined, canManageSettings: false, canManageMembers: false });
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
