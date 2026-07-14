// ---------------------------------------------------------------------------
// Selection hydration for the permissions page's AccessCombobox
// (cinatra#1508 / #1509 §4.1, codex F5).
//
// `availableScopes.teams` is built from the VIEWER's team memberships, so a
// project whose stored access state references a team the viewer isn't in
// never hydrated — the picker fell back to "Unknown team" with no checked row.
// These pure helpers derive the CLOSED set of team ids the page may resolve
// names for, and merge the server-resolved results into the viewer's list.
//
// The input set is exclusively server-derived state the viewer is already
// entitled to see: the project's own stored access expression + its
// project_access rows. NEVER feed client-supplied ids through this path — the
// org-bounded name lookup (`readTeamsByIdsForOrg`) must not become an
// arbitrary id → name oracle.
//
// Pure + dependency-free so both the page (server) and unit tests consume it.
// ---------------------------------------------------------------------------

export type TeamScopeEntry = { id: string; name: string };

/**
 * Collect the team ids referenced by the project's stored access state:
 * the canonical access expression (`team:<id>` form only) plus every
 * team-level `project_access` row. Deduped; blank ids dropped.
 */
export function collectAccessStateTeamIds(
  accessExpression: string,
  projectAccessRows: ReadonlyArray<{ principalLevel: string; principalId: string }>,
): string[] {
  const ids = new Set<string>();

  if (accessExpression.startsWith("team:")) {
    const id = accessExpression.slice("team:".length).trim();
    if (id) ids.add(id);
  }

  for (const row of projectAccessRows) {
    if (row.principalLevel !== "team") continue;
    const id = row.principalId.trim();
    if (id) ids.add(id);
  }

  return [...ids];
}

/**
 * Merge server-resolved team entries into the viewer's team list. The
 * viewer's entries win on id conflicts (they are already correct for the
 * active org); resolved-only entries are appended in their (name-ordered)
 * resolution order, so member-visible ordering never churns.
 */
export function mergeResolvedTeams(
  viewerTeams: ReadonlyArray<TeamScopeEntry>,
  resolvedTeams: ReadonlyArray<TeamScopeEntry>,
): TeamScopeEntry[] {
  const seen = new Set(viewerTeams.map((t) => t.id));
  const merged = [...viewerTeams];
  for (const team of resolvedTeams) {
    if (seen.has(team.id)) continue;
    seen.add(team.id);
    merged.push(team);
  }
  return merged;
}
