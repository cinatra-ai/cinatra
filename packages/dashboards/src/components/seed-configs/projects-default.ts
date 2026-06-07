/**
 * Seed config for `/projects` (DSH-01 / DSH-06 / DSH-07).
 *
 * Single portlet backed by the `projects` cube. Default tile shows the
 * `cinatraLinkedTable` chart with Name (linked to /projects/[id]) and
 * Organization columns. Archived projects are hidden by the cube's SQL
 * predicate, not by the seed query.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

export const PROJECTS_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "projects-list",
      title: "Projects",
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
          dimensions: [
            "projects.id",
            "projects.name",
            "projects.organization_name",
          ],
          order: { "projects.name": "asc" },
          limit: 500,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/**
 * Per-org-per-user dashboard row id. Same shape as the agents seed —
 * cross-org isolation + per-user customisation. `system-projects` is the
 * stable prefix; `ownerLevel="user"` + `ownerId=userId` is set by the
 * mutation service.
 */
export function buildProjectsDashboardId(organizationId: string, userId: string): string {
  return `system-projects:${organizationId}:${userId}`;
}
