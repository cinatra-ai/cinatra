// ---------------------------------------------------------------------------
// Team-membership management authority (cinatra#1567, extended by #1566).
//
// Pure, dependency-free predicate shared by the settings page (controls
// visibility + the widened page gate) and the member server actions (the
// authority gate). It lives OUTSIDE `member-actions.ts` because a
// "use server" module may only export async functions — the same split as
// `grant-candidates.ts` next to the project permissions actions.
//
// Authority for managing a team's membership (add/remove/role changes):
//   - a TEAM ADMIN of that team (`teamMember.role = 'admin'` — the per-team
//     role model from cinatra#1566; this predicate was built to be swapped
//     when that decision landed), or
//   - an org owner/admin of the TEAM's organization (the same widening the
//     teams-dashboard visibility uses — `TEAM_WIDENING_ORG_ROLES` in
//     `packages/dashboards/src/auth/team-visibility.ts`), or
//   - a platform admin.
// Plain team membership deliberately does NOT manage membership (mirrors the
// slug-rename action's stance that destructive team ops need explicit
// authority). On deployments where the role column is not provisioned yet,
// callers pass `teamRole: undefined` and the predicate reduces to the org /
// platform tiers — the pre-#1566 behavior.
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
  /**
   * The caller's role in THIS team (DB vocabulary, from `teamMember.role`).
   * `undefined` = not a team member, unknown role, or the role column is not
   * provisioned on this deployment (degrade to org/platform authority only).
   */
  readonly teamRole?: "admin" | "member";
};

/**
 * May the caller manage a team's membership (add/remove members, change
 * roles)? Team admin of the team, org owner/admin of the team's org, or
 * platform admin. `member`, `undefined`, and unknown roles fail closed.
 */
export function canManageTeamMembers(input: TeamMemberAuthorityInput): boolean {
  if (input.platformAdmin) return true;
  if (input.teamRole === "admin") return true;
  return (
    input.orgRole !== undefined &&
    (TEAM_MEMBER_MANAGING_ORG_ROLES as readonly string[]).includes(input.orgRole)
  );
}
