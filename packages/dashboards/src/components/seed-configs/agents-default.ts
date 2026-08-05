/**
 * Seed config for /agents.
 *
 * Two portlets backed by the agent_runs cube:
 *   1. "Top 5 recently used agents" — bar chart of run count by agent_name,
 *      descending, limit 5.
 *   2. "5 latest agent runs" — PER-RUN `cinatraLinkedTable` (cinatra#2448):
 *      one row per run_id, columns Run name (linked to
 *      `/agents/<vendor>/<packageName>/<runId>`), Agent, Status, Created at
 *      — newest first, limit 5. run_id/vendor/package_name ride along as
 *      hidden link-material dimensions consumed by the renderer.
 *
 * The drizzle-cube `DashboardGrid` mounts this directly as a
 * `DashboardConfig` (its TS type). We use the local `DashboardConfigV1_1`
 * shape (same structure, decoupled name) so sdk-dashboard's barrier stays
 * intact. Member names are fully qualified — `agent_runs.count`,
 * `agent_runs.agent_name`, `agent_runs.last_run_at`.
 *
 * Lives under `packages/dashboards/src/components/seed-configs/` so it
 * sits inside the ESLint Layer 4 carve-out (drizzle-cube/client type
 * imports allowed). This file uses the local dashboard config schema type
 * instead of importing drizzle-cube types, but the carve-out future-proofs it.
 */
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";

/**
 * Initial config persisted on first save of /agents. id of the dashboard
 * row is `system-agents-default` (hardcoded — there is one per Cinatra
 * deployment, scoped at the org level via the actor's organizationId).
 */
export const AGENTS_DEFAULT_CONFIG: DashboardConfigV1_1 = {
  portlets: [
    {
      id: "agents-top-recent",
      title: "Top 5 recently used agents",
      w: 6,
      h: 8,
      x: 0,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "chart",
        charts: {
          query: {
            chartType: "bar",
            chartConfig: {
              xAxis: ["agent_runs.agent_name"],
              yAxis: ["agent_runs.count"],
            },
            displayConfig: {},
          },
        },
        query: {
          measures: ["agent_runs.count"],
          dimensions: ["agent_runs.agent_name"],
          order: { "agent_runs.count": "desc" },
          limit: 5,
        },
      },
    },
    {
      id: "agents-latest-runs",
      title: "5 latest agent runs",
      w: 6,
      h: 8,
      x: 6,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "table",
        charts: {
          query: {
            // Per-run linked table (cinatra#2448): the renderer links the
            // Run cell to `/agents/<vendor>/<packageName>/<runId>` built
            // from the row's own vendor/package_name/run_id values and
            // hides those three link-material columns.
            chartType: "cinatraLinkedTable",
            chartConfig: {},
            displayConfig: {},
          },
        },
        query: {
          measures: [],
          // Dimensioning on run_id makes each RUN its own row — two runs
          // of the same agent never collapse (cinatra#2448).
          dimensions: [
            "agent_runs.run_id",
            "agent_runs.run_name",
            "agent_runs.agent_name",
            "agent_runs.status",
            "agent_runs.created_at",
            "agent_runs.vendor",
            "agent_runs.package_name",
          ],
          order: { "agent_runs.created_at": "desc" },
          limit: 5,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/**
 * Build the per-org-per-user dashboard row id for /agents.
 *
 * The global `system-agents-default` id would create a cross-org leak: the
 * first org to save would own the layout, and other orgs could read it. By
 * including both organizationId AND userId in the id, we get:
 *
 *   - Cross-org isolation: User X switching from Org-A to Org-B sees a
 *     different row (or seed on first visit) regardless of who else saved.
 *   - Per-user customisation: every user maintains their own /agents
 *     layout. ownerLevel="user" + ownerId=userId in the mutation service
 *     gives canWrite without any org-role gating.
 *
 * The row's organizationId column is still set to the actor's active org,
 * which keeps the cross-org check in resolveDashboardAccess as a defense.
 */
export function buildAgentsDashboardId(organizationId: string, userId: string): string {
  return `system-agents:${organizationId}:${userId}`;
}
