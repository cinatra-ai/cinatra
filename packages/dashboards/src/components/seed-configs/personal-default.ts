/**
 * Seed config for `/personal`.
 *
 * Unlike the entity dashboards (projects / teams / organizations / agents /
 * artifacts), Personal is "your private dashboard, built from the cards you
 * add" — it starts EMPTY and the user grows it via the portlet toolbar's
 * add-card affordance, then saves. This preserves the behaviour of the legacy
 * `DeskDashboardGrid` (which seeded an empty grid) while the #626 migration to
 * `EmbeddedDrizzleCubeDashboardGrid` adds the grey portlet toolbar, the
 * Edit-dashboard affordance, and per-user persistence the other Management
 * dashboards already have.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

export const PERSONAL_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/**
 * Per-org-per-user dashboard row id. Same shape as the other entity seeds —
 * cross-org isolation + per-user customisation. `system-personal` is the
 * stable prefix; `ownerLevel="user"` + `ownerId=userId` is set by the
 * mutation service.
 */
export function buildPersonalDashboardId(organizationId: string, userId: string): string {
  return `system-personal:${organizationId}:${userId}`;
}
