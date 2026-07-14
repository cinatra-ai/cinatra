// ---------------------------------------------------------------------------
// Grant-form principal helpers (cinatra#1505 / #1509 §4.2).
//
// Pure, dependency-free helpers shared by the ProjectAccessSection grant form
// (client) and the grant-candidate server actions. They live OUTSIDE
// `actions.ts` because a "use server" module may only export async functions —
// the same split as `access-team-hydration.ts`.
// ---------------------------------------------------------------------------

/** Principal levels a project access grant can target. */
export type GrantPrincipalLevel = "user" | "team" | "organization" | "workspace";

/** Sentinel principal id for workspace-level grants (unchanged — §4.2). */
export const WORKSPACE_PRINCIPAL_ID = "__workspace__";

/**
 * Static Title-Case label map for the grant form's principal control
 * (cinatra#1505 AC; §3.2: labels are Title Case nouns and NEVER interpolate
 * enum values — this replaces the retired `${principalLevel} id` template).
 */
export const PRINCIPAL_LEVEL_LABELS: Record<GrantPrincipalLevel, string> = {
  user: "User",
  team: "Team",
  organization: "Organization",
  workspace: "Workspace",
};

/**
 * Build the ILIKE pattern for a user-supplied search term, or `null` for a
 * blank query (callers then skip the name/email predicate). Clone-basis:
 * `searchWorkspaceUsersForProject` (§3.5 reference implementation) — escape
 * the LIKE/ILIKE escape character (backslash) FIRST, then the `%`/`_`
 * wildcards, all via the single character class `[\\%_]`. Postgres ILIKE uses
 * backslash as the default ESCAPE char; without escaping a user-supplied `\`
 * the pattern semantics drift (e.g. `\%` would stop being a literal match).
 */
export function toIlikePattern(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * The minimal shape of an existing access row the grant form needs to mark or
 * exclude already-granted principals (§4.2: "Already granted — <role>").
 * Structurally satisfied by `ProjectAccessRow`.
 */
export type GrantedPrincipalRef = {
  principalLevel: GrantPrincipalLevel;
  principalId: string;
  role: string;
};

/**
 * Role already granted to a principal, or `null` when the principal holds no
 * row yet. The synthesized implicit-owner row counts (the owner is already
 * granted by definition).
 */
export function alreadyGrantedRole(
  rows: readonly GrantedPrincipalRef[],
  level: GrantPrincipalLevel,
  principalId: string,
): string | null {
  const hit = rows.find(
    (r) => r.principalLevel === level && r.principalId === principalId,
  );
  return hit ? hit.role : null;
}

/** Ids of principals at `level` that already hold a grant — feeds the user
 *  picker's `excludeIds` (exclusion variant of the §4.2 exclude-or-mark rule). */
export function grantedPrincipalIds(
  rows: readonly GrantedPrincipalRef[],
  level: GrantPrincipalLevel,
): string[] {
  return rows.filter((r) => r.principalLevel === level).map((r) => r.principalId);
}
