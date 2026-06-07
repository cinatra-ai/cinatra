import type { Metadata } from "next";

export const metadata: Metadata = { title: "Teams" };

// /teams is a DC dashboard.
export { TeamsDashboardPage as default } from "@cinatra-ai/dashboards/screens";
