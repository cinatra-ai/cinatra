import type { Metadata } from "next";

export const metadata: Metadata = { title: "Organization" };

// /organizations/[id] renders a per-org detail DC dashboard (read-only, scoped
// to the single org). The /organizations linked table now links rows here.
export { OrganizationDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
