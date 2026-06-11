import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// resolveOrgRoleFromMembership / mapMembershipRoleToOrgRole tests
//
// The MCP transport resolves the caller's org-membership role ONCE at
// context-build time and stamps it on mcpRequestContextStorage.orgRole so MCP
// handlers can evaluate org role natively (issue #83). The mapping must stay
// identical to cachedResolveOrgRole in src/lib/auth-session.ts:
//   owner → org_owner, admin → org_admin, member → member, else undefined.
//
// RBAC-sensitive invariants covered here:
//   - no membership row → undefined (no role is ever synthesized)
//   - unknown role strings → undefined (defensive)
//   - DB error → undefined (fail to "not carried", never to a role)
//   - missing orgId or userId → undefined without querying
// ---------------------------------------------------------------------------

import {
  mapMembershipRoleToOrgRole,
  resolveOrgRoleFromMembership,
} from "../actor-identity";

const queryMock = vi.fn();
const pool = { query: queryMock as never } as Parameters<
  typeof resolveOrgRoleFromMembership
>[0]["pool"];

describe("mapMembershipRoleToOrgRole", () => {
  it("maps better-auth membership roles to kernel org roles", () => {
    expect(mapMembershipRoleToOrgRole("owner")).toBe("org_owner");
    expect(mapMembershipRoleToOrgRole("admin")).toBe("org_admin");
    expect(mapMembershipRoleToOrgRole("member")).toBe("member");
  });

  it("returns undefined for unknown / null / undefined roles (never synthesizes)", () => {
    expect(mapMembershipRoleToOrgRole("org_admin")).toBeUndefined();
    expect(mapMembershipRoleToOrgRole("superuser")).toBeUndefined();
    expect(mapMembershipRoleToOrgRole("")).toBeUndefined();
    expect(mapMembershipRoleToOrgRole(null)).toBeUndefined();
    expect(mapMembershipRoleToOrgRole(undefined)).toBeUndefined();
  });
});

describe("resolveOrgRoleFromMembership", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("resolves the membership row for the exact (orgId, userId) pair", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ role: "admin" }] });
    const role = await resolveOrgRoleFromMembership({
      orgId: "org-1",
      userId: "user-1",
      pool,
    });
    expect(role).toBe("org_admin");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('public."member"');
    expect(params).toEqual(["org-1", "user-1"]);
  });

  it("returns undefined when no membership row exists", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const role = await resolveOrgRoleFromMembership({
      orgId: "org-1",
      userId: "stranger",
      pool,
    });
    expect(role).toBeUndefined();
  });

  it("returns undefined without querying when orgId or userId is missing", async () => {
    expect(
      await resolveOrgRoleFromMembership({ orgId: null, userId: "user-1", pool }),
    ).toBeUndefined();
    expect(
      await resolveOrgRoleFromMembership({ orgId: "org-1", userId: null, pool }),
    ).toBeUndefined();
    expect(
      await resolveOrgRoleFromMembership({ orgId: undefined, userId: undefined, pool }),
    ).toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns undefined (non-fatal) when the lookup throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const role = await resolveOrgRoleFromMembership({
      orgId: "org-1",
      userId: "user-1",
      pool,
    });
    expect(role).toBeUndefined();
    warnSpy.mockRestore();
  });
});
