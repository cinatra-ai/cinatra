import type { Metadata } from "next";

export const metadata: Metadata = { title: "Projects" };

// /projects is a DC dashboard. The dashboard reads the project-grant
// visibility surface via the projects cube. Per-row navigation goes
// through the cinatraLinkedTable chart plugin
// (`<Link href="/projects/[id]">`), preserving middle-click +
// right-click affordances.
export { ProjectsDashboardPage as default } from "@cinatra-ai/dashboards/screens";
