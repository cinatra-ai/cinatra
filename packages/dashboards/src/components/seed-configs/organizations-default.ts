/**
 * Seed config for `/organizations`.
 *
 * Single portlet backed by the `organizations` cube. Default tile shows
 * `cinatraLinkedTable` with Name + Role + Teams (comma-separated team
 * names) + Members (total count). The
 * organizations route has no per-org detail page — the
 * `cinatraLinkedTable` component intentionally has no entry for the
 * `organizations` cube, so the Name column renders as plain text.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

export const ORGANIZATIONS_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "organizations-list",
      title: "Organizations",
      w: 12,
      h: 10,
      x: 0,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "table",
        charts: {
          query: {
            chartType: "cinatraLinkedTable",
            chartConfig: {},
            displayConfig: {},
          },
        },
        query: {
          measures: ["organizations.member_count"],
          dimensions: [
            "organizations.id",
            "organizations.name",
            "organizations.role",
            "organizations.team_names",
          ],
          order: { "organizations.name": "asc" },
          limit: 500,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

export function buildOrganizationsDashboardId(organizationId: string, userId: string): string {
  return `system-organizations:${organizationId}:${userId}`;
}
