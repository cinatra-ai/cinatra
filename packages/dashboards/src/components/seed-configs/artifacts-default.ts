/**
 * Seed config for `/artifacts`.
 *
 * Single portlet backed by the `artifacts` cube. Default tile shows
 * `cinatraLinkedTable` with Name (linked to `/artifacts/[id]`) and
 * Context columns. The cube's SQL predicate already restricts to
 * artifact-typed objects via `visibleArtifactIds`.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

export const ARTIFACTS_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "artifacts-list",
      title: "Artifacts",
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
            "artifacts.id",
            "artifacts.name",
            "artifacts.context",
          ],
          order: { "artifacts.name": "asc" },
          limit: 500,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

export function buildArtifactsDashboardId(organizationId: string, userId: string): string {
  return `system-artifacts:${organizationId}:${userId}`;
}
