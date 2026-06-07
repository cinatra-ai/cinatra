import type { Metadata } from "next";

export const metadata: Metadata = { title: "Team" };

// /teams/[teamId] renders a per-team detail DC dashboard (read-only, scoped to
// the single team). The /teams linked table already points rows here; this
// route resolves the prior 404. Sibling `/teams/[teamId]/settings` is
// unaffected.
export { TeamDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
