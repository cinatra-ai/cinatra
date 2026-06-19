/**
 * Unit coverage for the shared MCP cube SecurityContext resolver.
 *
 * Both MCP closure sites — handlers.ts AND registry.ts — call
 * `buildDashboardCubeMcpSecurityContext`. This proves it:
 *   - widens accessibleOrgIds via the org-membership resolver,
 *   - decorates isPlatformAdmin from the explicit by-userId role lookup
 *     (the MCP identity chain carries NO role, so this lookup is required —
 *     without it agents/MCP would ALWAYS see zero llm_usage rows), and
 *   - fails closed (isPlatformAdmin=false) when the role lookup throws.
 */
import { describe, expect, it } from "vitest";

import { buildDashboardCubeMcpSecurityContext } from "../security-context";

describe("buildDashboardCubeMcpSecurityContext", () => {
  const identity = { userId: "u-admin", organizationId: "org-a" };

  it("returns null when identity is incomplete", async () => {
    const sc = await buildDashboardCubeMcpSecurityContext(
      { userId: "", organizationId: "" },
      async () => ["org-a"],
      async () => true,
    );
    expect(sc).toBeNull();
  });

  it("widens accessibleOrgIds AND sets isPlatformAdmin=true for an admin", async () => {
    const sc = await buildDashboardCubeMcpSecurityContext(
      identity,
      async () => ["org-a", "org-b"],
      async (userId) => userId === "u-admin",
    );
    expect(sc).not.toBeNull();
    expect(new Set(sc!.accessibleOrgIds)).toEqual(new Set(["org-a", "org-b"]));
    expect(sc!.isPlatformAdmin).toBe(true);
  });

  it("sets isPlatformAdmin=false for a non-admin (cube fails closed → zero rows)", async () => {
    const sc = await buildDashboardCubeMcpSecurityContext(
      { userId: "u-regular", organizationId: "org-a" },
      async () => ["org-a"],
      async () => false,
    );
    expect(sc!.isPlatformAdmin).toBe(false);
  });

  it("fails closed (isPlatformAdmin=false) when the role lookup throws", async () => {
    const sc = await buildDashboardCubeMcpSecurityContext(
      identity,
      async () => ["org-a"],
      async () => {
        throw new Error("db down");
      },
    );
    expect(sc).not.toBeNull();
    expect(sc!.isPlatformAdmin).toBe(false);
    // org widening still applied.
    expect(sc!.accessibleOrgIds).toContain("org-a");
  });
});
