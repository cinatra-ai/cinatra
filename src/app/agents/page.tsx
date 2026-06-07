import type { Metadata } from "next";

export const metadata: Metadata = { title: "Agents" };

// /agents is the dashboard with top-5-recently-used and 5-latest widgets.
// It is the installed-agents surface.
export { AgentsDashboardPage as default } from "@cinatra-ai/dashboards/screens";
