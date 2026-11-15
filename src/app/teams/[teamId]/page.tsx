import type { Metadata } from "next";

import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";
import { scopeSurfaceEntityLabel } from "@/lib/scope-surfaces";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the page's read gate before disclosing the team name. A
// refused or missing team, or any failure of the read, yields the generic
// title; a reader the gate allows whose team has a blank name gets the id's
// first eight characters plus an ellipsis, as the crumb does. The gate and the read live in ONE place
// (cinatra#2807 fix leg 2) so this tab title and the page heading beneath it
// can never disagree about what the viewer may be told.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ teamId: string }>;
}): Promise<Metadata> {
  const { teamId } = await params;
  const scope = { kind: "team", id: teamId } as const;
  // The tab mirrors the trail's entity crumb under the same rules (cinatra#4453).
  return { title: scopeSurfaceEntityLabel(scope, await readScopeSurfaceEntityName(scope)) };
}

// /teams/[teamId] renders the per-team dashboards surface (read-only Overview
// + custom dashboards). The /teams linked table points rows here. Team
// MANAGEMENT (members, roles, rename) lives on the sibling
// `/teams/[teamId]/settings` — the single management surface (cinatra#1688).
export { TeamDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
