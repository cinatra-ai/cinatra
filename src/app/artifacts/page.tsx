import type { Metadata } from "next";

export const metadata: Metadata = { title: "Artifacts" };

// /artifacts is a DC dashboard.
export { ArtifactsDashboardPage as default } from "@cinatra-ai/dashboards/screens";
