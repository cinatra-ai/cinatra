/**
 * RBAC: dashboards MCP actor extraction must understand the KERNEL org-role
 * vocabulary stamped by the MCP registry (PrimitiveActorContext.orgRole is
 * "org_owner" | "org_admin" | "member", carried natively per issue #83), in
 * addition to the dashboards-local Better Auth vocabulary ("owner" | "admin" |
 * "member") used by the route layer.
 *
 * Regression: before normalization, a transport-carried "org_admin" /
 * "org_owner" passed the TypeScript cast unvalidated and then failed the
 * resolver's `orgRole === "admin" || orgRole === "owner"` owner check — org
 * admins/owners were silently demoted to member on the MCP path (deny-only,
 * but the carried role was never honored).
 */
import { describe, expect, it } from "vitest";

import { normalizeOrgRole } from "../mcp/handlers";

describe("dashboards MCP normalizeOrgRole", () => {
  it("maps the kernel vocabulary to the dashboards-local one", () => {
    expect(normalizeOrgRole("org_owner")).toBe("owner");
    expect(normalizeOrgRole("org_admin")).toBe("admin");
    expect(normalizeOrgRole("member")).toBe("member");
  });

  it("passes the dashboards-local vocabulary through unchanged", () => {
    expect(normalizeOrgRole("owner")).toBe("owner");
    expect(normalizeOrgRole("admin")).toBe("admin");
  });

  it("never widens: unknown / absent / forged values fall back to member", () => {
    expect(normalizeOrgRole(undefined)).toBe("member");
    expect(normalizeOrgRole(null)).toBe("member");
    expect(normalizeOrgRole("")).toBe("member");
    expect(normalizeOrgRole("platform_admin")).toBe("member");
    expect(normalizeOrgRole("ORG_ADMIN")).toBe("member");
    expect(normalizeOrgRole(42)).toBe("member");
    expect(normalizeOrgRole({ role: "org_owner" })).toBe("member");
  });
});
