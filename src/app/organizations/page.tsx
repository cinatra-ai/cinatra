import type { Metadata } from "next";

export const metadata: Metadata = { title: "Organizations" };

// /organizations is a DC dashboard.
export { OrganizationsDashboardPage as default } from "@cinatra-ai/dashboards/screens";
