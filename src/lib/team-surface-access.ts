/**
 * Who may open a team's own surfaces, as ONE pure decision (cinatra#3787).
 *
 * THE TENANT OF A TEAM SURFACE IS THE TEAM'S ORGANIZATION, never the session's
 * active one. The owner's decision on cinatra#3693 settles it for the whole
 * scope: "a run started from the Agents tab of an organization's, team's or
 * project's scope belongs to that scope's organization, whatever the session's
 * active organization is." A team's landing, its name and its dashboard actions
 * follow the same rule, so the reader who may open the Agents tab of a team can
 * also open its landing and read its name.
 *
 * What this replaced: the landing and the name read each compared the session's
 * ACTIVE organization with the team's and refused whenever the two differed,
 * BEFORE asking about authority at all. A platform admin who owns every
 * organization and administers the team therefore met "This area is limited to
 * platform admins", with the raw team id in the trail and the bare word "Team"
 * as the heading. The comparison protected the dashboard actions, which derived
 * their tenant from the session; the actions now carry the team's organization
 * explicitly, so the comparison has nothing left to protect.
 *
 * The decision lives here, pure and dependency-free, because three callers take
 * it: the team landing (`TeamDetailDashboardPage`), the team dashboard actions
 * (`authorizeTeamDashboards`) and the gated name read (`readTeamName`). One
 * function is how they cannot drift apart, and how each case is testable with no
 * database.
 */
import {
  canManageTeamMembers,
  type TeamMemberAuthorityInput,
} from "@/app/teams/[teamId]/settings/team-member-authority";

/** The one reason a team surface refuses, and the `/not-authorized` value that
 *  says it in words (`src/lib/not-authorized-reason.ts`). */
export const TEAM_SURFACE_REFUSAL_REASON = "scope-membership" as const;

export type TeamSurfaceAccessInput = {
  /**
   * The team row, read BY ID ALONE, never confined to the session's active
   * organization. `null`/`undefined` means no such team.
   */
  readonly team: { readonly organizationId: string } | null | undefined;
  /** Does the caller hold a membership row on THIS team? */
  readonly isMember: boolean;
  /** `isPlatformAdmin(session)`. */
  readonly platformAdmin: boolean;
  /**
   * The caller's role in the TEAM's organization, resolved with
   * `resolveOrgRoleForUser(team.organizationId, userId)`, never against the
   * session's active organization.
   */
  readonly orgRole: TeamMemberAuthorityInput["orgRole"];
  /** The caller's role on THIS team, where the role column is provisioned. */
  readonly teamRole?: TeamMemberAuthorityInput["teamRole"];
};

export type TeamSurfaceAccess =
  /** Open the surface. `canManage` carries the write authority the page needs. */
  | { readonly outcome: "allowed"; readonly canManage: boolean }
  /** No such team. The caller learns nothing about it (`notFound()`). */
  | { readonly outcome: "not-found" }
  /** A real team the caller holds nothing on. */
  | { readonly outcome: "refused"; readonly reason: typeof TEAM_SURFACE_REFUSAL_REASON };

/**
 * May the caller open this team's surface? Membership views; management
 * (platform admin, an owner or admin of the TEAM's organization, a team admin)
 * views and writes. An unknown team is not found, which is answered first so a
 * missing team never reaches an authority question.
 */
export function resolveTeamSurfaceAccess(
  input: TeamSurfaceAccessInput,
): TeamSurfaceAccess {
  if (!input.team) return { outcome: "not-found" };
  const canManage = canManageTeamMembers({
    platformAdmin: input.platformAdmin,
    orgRole: input.orgRole,
    ...(input.teamRole ? { teamRole: input.teamRole } : {}),
  });
  if (!input.isMember && !canManage) {
    return { outcome: "refused", reason: TEAM_SURFACE_REFUSAL_REASON };
  }
  return { outcome: "allowed", canManage };
}
