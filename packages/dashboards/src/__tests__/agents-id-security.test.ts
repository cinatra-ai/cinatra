import { describe, expect, it } from "vitest";

import {
  dashboardsCreateSchema,
  RESERVED_SYSTEM_DASHBOARD_PREFIX,
} from "../mcp/schemas";
import { buildAgentsDashboardId } from "../components/seed-configs/agents-default";

/**
 * /agents id security.
 *
 * The /agents screen materialises its row via `saveAgentsDashboardAction`
 * at id `system-agents:<orgId>:<userId>` (ownerLevel:"user",
 * visibility:"private"). MCP `dashboards_create` must not accept any id,
 * including one that matches another user's expected /agents row id —
 * otherwise an attacker could pre-create the victim's row as their own
 * user-owned row and the victim's screen would then load it.
 *
 * Defense in depth:
 *  - MCP schema (dashboardsCreateSchema) REJECTS any id starting with
 *    `system-` (reserved prefix). Tested here.
 *  - The /agents screen read path filters by id AND organizationId AND
 *    ownerId AND ownerLevel="user" — a mismatched row is treated as
 *    missing and the seed is rendered. (See `screens/agents-dashboard.tsx`.)
 */

describe("/agents id security", () => {
  it("buildAgentsDashboardId returns a system- prefixed composite id", () => {
    const id = buildAgentsDashboardId("org-acme", "user-42");
    expect(id).toBe("system-agents:org-acme:user-42");
    expect(id.startsWith(RESERVED_SYSTEM_DASHBOARD_PREFIX)).toBe(true);
  });

  it("buildAgentsDashboardId produces a different id per (org, user) pair", () => {
    expect(buildAgentsDashboardId("org-a", "u1")).not.toBe(
      buildAgentsDashboardId("org-b", "u1"),
    );
    expect(buildAgentsDashboardId("org-a", "u1")).not.toBe(
      buildAgentsDashboardId("org-a", "u2"),
    );
  });

  it("dashboardsCreateSchema REJECTS ids starting with system-", () => {
    // Direct attempt to pre-create a victim's /agents row.
    const r = dashboardsCreateSchema.safeParse({
      dashboardId: "system-agents:victim-org:victim-user",
      name: "poison",
      config: { portlets: [] },
      ownerLevel: "user",
      ownerId: "attacker",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/reserved/);
    }
  });

  it("dashboardsCreateSchema REJECTS any system-* prefixed id (not just system-agents:)", () => {
    const r = dashboardsCreateSchema.safeParse({
      dashboardId: "system-future-feature:whatever",
      name: "x",
      config: { portlets: [] },
      ownerLevel: "user",
      ownerId: "u",
    });
    expect(r.success).toBe(false);
  });

  it("dashboardsCreateSchema ACCEPTS ordinary (non-reserved) ids", () => {
    const r = dashboardsCreateSchema.safeParse({
      dashboardId: "my-custom-dashboard",
      name: "x",
      config: { portlets: [] },
      ownerLevel: "user",
      ownerId: "u",
    });
    expect(r.success).toBe(true);
  });

  it("dashboardsCreateSchema ACCEPTS empty/missing dashboardId (server generates)", () => {
    const r = dashboardsCreateSchema.safeParse({
      name: "x",
      config: { portlets: [] },
      ownerLevel: "user",
      ownerId: "u",
    });
    expect(r.success).toBe(true);
  });
});
