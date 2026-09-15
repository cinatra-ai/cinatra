import type { Metadata } from "next";

import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the page's read gate before disclosing the team name; any
// failure yields the generic title. The gate and the read live in ONE place
// (cinatra#2807 fix leg 2) so this tab title and the page heading beneath it
// can never disagree about what the viewer may be told.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ teamId: string }>;
}): Promise<Metadata> {
  const { teamId } = await params;
  const name = await readScopeSurfaceEntityName({ kind: "team", id: teamId });
  return { title: name || "Team" };
}

// /teams/[teamId] renders the per-team dashboards surface (read-only Overview
// + custom dashboards). The /teams linked table points rows here. Team
// MANAGEMENT (members, roles, rename) lives on the sibling
// `/teams/[teamId]/settings` — the single management surface (cinatra#1688).
export { TeamDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
