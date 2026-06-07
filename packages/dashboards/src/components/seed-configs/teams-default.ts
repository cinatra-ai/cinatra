/**
 * Seed config for `/teams` (DSH-02 / DSH-07).
 *
 * Single portlet backed by the `teams` cube. Default tile shows the
 * `cinatraLinkedTable` chart with Name (linked to /teams/[id]) and
 * Organization columns.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

export const TEAMS_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "teams-list",
      title: "Teams",
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
          measures: [],
          dimensions: ["teams.id", "teams.name", "teams.organization_name"],
          order: { "teams.name": "asc" },
          limit: 500,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

export function buildTeamsDashboardId(organizationId: string, userId: string): string {
  return `system-teams:${organizationId}:${userId}`;
}
