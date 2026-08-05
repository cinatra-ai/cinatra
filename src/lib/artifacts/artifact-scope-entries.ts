// ---------------------------------------------------------------------------
// Artifact → scope-filter entries (cinatra#2449).
//
// Maps a library row's ownership projection (ownerLevel + ownerId /
// organizationId / projectId, projected by `toSummary` straight from the
// object row) onto the shared `NormalizedResourceScope` vocabulary so the
// `/artifacts` library filters through the SAME canonical predicates as
// /connectors and /skills (`@/lib/scope-filter`).
//
// Semantics (mirroring the /skills level mapping + the cinatra#953 W3
// fail-closed doctrine):
//   - ownerLevel "user"          → { locus: "personal" }
//   - ownerLevel "team"          → { locus: "team", locusId: ownerId } —
//     at team level the object row's ownerId IS the owning team's id
//     (enforce-resource-access.ts team-owner short-circuit).
//   - ownerLevel "organization"  → { locus: "organization", locusId } bound to
//     the row's org. An id-less row stays locus-level and so matches ONLY the
//     default view (fail-closed under an id-carrying selection).
//   - ownerLevel "workspace"     → { locus: "workspace" } — default view only.
//   - a non-null projectId adds a SECOND entry { locus: "project", locusId }:
//     a project-bound artifact matches its project's token IN ADDITION to its
//     owner locus (OR across a row's entries, exactly like the connectors
//     per-connector entry list).
//
// Artifacts carry no admin-only visibility tier, so no entry ever sets
// `adminOnly` — the "admin" token is not offered on this surface.
// ---------------------------------------------------------------------------

import type { NormalizedResourceScope } from "@/lib/scope-filter";

export type ArtifactScopeProjection = {
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string | null;
  organizationId: string | null;
  projectId: string | null;
};

export function artifactScopeEntries(
  row: ArtifactScopeProjection,
): NormalizedResourceScope[] {
  const entries: NormalizedResourceScope[] = [];
  switch (row.ownerLevel) {
    case "user":
      entries.push({ locus: "personal" });
      break;
    case "team":
      entries.push({ locus: "team", locusId: row.ownerId ?? undefined });
      break;
    case "organization":
      entries.push({
        locus: "organization",
        locusId: row.organizationId ?? row.ownerId ?? undefined,
      });
      break;
    default:
      entries.push({ locus: "workspace" });
      break;
  }
  if (row.projectId) {
    entries.push({ locus: "project", locusId: row.projectId });
  }
  return entries;
}
