// /agents tab-bar model (cinatra#1007).
//
// /agents was restructured into two tabs:
//   - "All Agents" (default) — the run-agent picker, now served AT /agents
//     (moved from the old /agents/run, which is removed/replaced — not
//     redirected; old deep links to /agents/run intentionally 404).
//   - "Executions" — the top-5-recently-used + 5-latest-run dashboard, moved
//     from the old /agents to /agents/executions.
//
// One shared list drives both AgentsTabNav render sites (the picker in
// packages/agents/src/pages.tsx and the dashboard in
// packages/dashboards/src/screens/agents-dashboard.tsx) so the tab labels/
// hrefs/order cannot drift between the two routes.
export type AgentsTabValue = "all" | "executions";

export type AgentsNavItem = {
  /** Stable key for the active-tab state. */
  value: AgentsTabValue;
  label: string;
  href: string;
};

export const AGENTS_NAV: readonly AgentsNavItem[] = [
  { value: "all", label: "All Agents", href: "/agents" },
  { value: "executions", label: "Executions", href: "/agents/executions" },
] as const satisfies readonly AgentsNavItem[];
