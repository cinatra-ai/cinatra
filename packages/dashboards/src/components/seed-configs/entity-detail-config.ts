/**
 * Per-entity detail dashboard configs.
 *
 * Unlike the index seed configs (`teams-default`, `organizations-default`),
 * these are NOT persisted and NOT user-customizable — they are built fresh on
 * each request from the entity id and rendered read-only
 * (`<DashboardGridContainer editable={false}>`). A single built-in DC `table`
 * portlet shows the entity's identity plus one metric, scoped to the single
 * entity via a same-cube `equals` filter on `<cube>.id`.
 *
 * Scoping is defense-in-depth: the filter narrows to the one id, AND the
 * cube's own `SecurityContext` predicate (`WHERE id IN (visibleTeamIds)` /
 * `WHERE id IN (accessibleOrgIds)`, applied in the cubejs route) still runs —
 * so an entity the actor cannot access yields zero rows (fail closed), never a
 * widened surface.
 *
 * The detail portlet uses DC's built-in `table` chart (NOT
 * `cinatraLinkedTable`) so the entity name renders as plain text instead of a
 * pointless self-link back to the same detail page.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

const DETAIL_GRID = { cols: 12, rowHeight: 50, minW: 3, minH: 4 } as const;

export function buildTeamDetailConfig(teamId: string): DashboardConfigV1_1 {
  return {
    portlets: [
      {
        id: "team-detail",
        title: "Team",
        w: 12,
        h: 6,
        x: 0,
        y: 0,
        analysisConfig: {
          version: 1,
          analysisType: "query",
          activeView: "table",
          charts: {
            query: { chartType: "table", chartConfig: {}, displayConfig: {} },
          },
          query: {
            measures: ["teams.member_count"],
            dimensions: ["teams.name", "teams.organization_name"],
            filters: [
              { member: "teams.id", operator: "equals", values: [teamId] },
            ],
            limit: 1,
          },
        },
      },
    ],
    layoutMode: "grid",
    grid: { ...DETAIL_GRID },
  };
}

export function buildOrganizationDetailConfig(orgId: string): DashboardConfigV1_1 {
  return {
    portlets: [
      {
        id: "organization-detail",
        title: "Organization",
        w: 12,
        h: 6,
        x: 0,
        y: 0,
        analysisConfig: {
          version: 1,
          analysisType: "query",
          activeView: "table",
          charts: {
            query: { chartType: "table", chartConfig: {}, displayConfig: {} },
          },
          query: {
            measures: ["organizations.member_count"],
            dimensions: [
              "organizations.name",
              "organizations.slug",
              "organizations.team_names",
            ],
            filters: [
              { member: "organizations.id", operator: "equals", values: [orgId] },
            ],
            limit: 1,
          },
        },
      },
    ],
    layoutMode: "grid",
    grid: { ...DETAIL_GRID },
  };
}
