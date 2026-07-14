// ---------------------------------------------------------------------------
// Team-membership management authority (cinatra#1567).
//
// Pure, dependency-free predicate shared by the settings page (controls
// visibility + the widened page gate) and the member server actions (the
// authority gate). It lives OUTSIDE `member-actions.ts` because a
// "use server" module may only export async functions — the same split as
// `grant-candidates.ts` next to the project permissions actions.
//
// INTERIM GATE — teams have NO role model yet (`public."teamMember"` has no
// `role` column; sibling cinatra#1566 owns that decision). Until #1566 lands,
// the defensible authority for adding/removing team members is:
//   - an org owner/admin of the TEAM's organization (the same widening the
//     teams-dashboard visibility uses — `TEAM_WIDENING_ORG_ROLES` in
//     `packages/dashboards/src/auth/team-visibility.ts`), or
//   - a platform admin.
// Plain team membership deliberately does NOT manage membership (mirrors the
// slug-rename action's stance that destructive team ops need org authority).
// When #1566 introduces per-team roles, swap THIS predicate — every caller
// routes through it by name, so the decision lands in one place.
// ---------------------------------------------------------------------------

/** Org roles (authz-kernel form) that may manage team membership. Mirrors
 *  `TEAM_WIDENING_ORG_ROLES` (team-visibility widening) — kept local so the
 *  app route does not import the dashboards package's auth internals. */
export const TEAM_MEMBER_MANAGING_ORG_ROLES = ["org_owner", "org_admin"] as const;

export type TeamMemberAuthorityInput = {
  /** `isPlatformAdmin(session)` — platform admins manage any team. */
  readonly platformAdmin: boolean;
  /**
   * The caller's role in the TEAM's organization (authz-kernel form, via
   * `resolveOrgRoleForUser(team.organizationId, userId)` — NEVER the viewer's
   * active org). `undefined` = no membership row / unknown role.
   */
  readonly orgRole: "org_owner" | "org_admin" | "member" | undefined;
};

/**
 * May the caller add/remove members of a team? Named predicate for the
 * interim (pre-#1566) authority: platform admin, or org owner/admin of the
 * team's org. `member`, `undefined`, and unknown roles fail closed.
 */
export function canManageTeamMembers(input: TeamMemberAuthorityInput): boolean {
  if (input.platformAdmin) return true;
  return (
    input.orgRole !== undefined &&
    (TEAM_MEMBER_MANAGING_ORG_ROLES as readonly string[]).includes(input.orgRole)
  );
}
