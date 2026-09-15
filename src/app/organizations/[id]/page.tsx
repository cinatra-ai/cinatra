import type { Metadata } from "next";

import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the page's read gate before disclosing the org name; any
// failure yields the generic title. The gate and the read live in ONE place
// (cinatra#2807 fix leg 2) so this tab title and the page heading beneath it
// can never disagree about what the viewer may be told.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const name = await readScopeSurfaceEntityName({ kind: "organization", id });
  return { title: name || "Organization" };
}

// /organizations/[id] renders a per-org detail DC dashboard (read-only, scoped
// to the single org). The /organizations linked table now links rows here.
export { OrganizationDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
