import type { Metadata } from "next";

export const metadata: Metadata = { title: "Team" };

// /teams/[teamId] renders the per-team dashboards surface (read-only Overview
// + custom dashboards). The /teams linked table points rows here. Team
// MANAGEMENT (members, roles, rename) lives on the sibling
// `/teams/[teamId]/settings` — the single management surface (cinatra#1688).
export { TeamDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
