// Build a dashboards read-visibility actor from the current session.
// Mirrors `buildWorkflowActorFromSession`, but carries the FULL `projectGrants`
// (projectId + effectiveRole) the dashboards read-visibility resolver needs — not just projectIds.
import "server-only";

import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import {
  readTeamsForUser,
  readProjectGrantsForUser,
  type TeamMembershipRow,
} from "@/lib/better-auth-db";
import type { DashboardAuthzActor } from "@/lib/dashboards/authz";

/**
 * Presence-aware team-role map from the SAME `readTeamsForUser` rows the actor's
 * `teamIds` derive from, so the two axes cannot drift (the role rides the single
 * membership query — no extra read). A known `'admin'` → `'admin'`; a known
 * `'member'` or the out-of-vocabulary `null` → `'member'`; a membership whose
 * app-owned `role` column is not provisioned (`role === undefined`, the
 * documented roleless-membership degrade) asserts NOTHING and is skipped — when
 * NO row carried a role the map stays unresolved (`undefined`), so a team admin
 * is not recognized on a deployment that never ran `auth:migrate` (fail-closed,
 * never over-grants a team-owner read). Mirrors auth-session.ts's
 * `toKernelTeamRoles` (cinatra#1566) built on property PRESENCE not truthiness;
 * the values are the dashboard-local `'admin'|'member'` the resolver's
 * team-owner gate reads (`resolveDashboardAccess`), which the adapter's
 * `normalizeTeamRoles` also accepts as the kernel `'team_admin'`.
 */
function toDashboardTeamRoles(
  teamRows: readonly TeamMembershipRow[],
): Record<string, "admin" | "member"> | undefined {
  let resolved = false;
  const map: Record<string, "admin" | "member"> = {};
  for (const t of teamRows) {
    if (t.role === undefined) continue;
    resolved = true;
    map[t.id] = t.role === "admin" ? "admin" : "member";
  }
  return resolved ? map : undefined;
}

export async function buildDashboardActorFromSession(): Promise<{
  actor: DashboardAuthzActor;
  orgId: string | null;
  userId: string;
}> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId = session.session?.activeOrganizationId ?? null;

  const teamRows = userId && orgId ? await readTeamsForUser(userId, orgId) : [];
  const teamIds = teamRows.map((t) => t.id);
  const teamRoles = toDashboardTeamRoles(teamRows);
  const orgRole = userId && orgId ? await resolveOrgRoleForSession(session) : null;
  const grants =
    userId && orgId
      ? await readProjectGrantsForUser(userId, orgId, { teamIds, ...(orgRole ? { orgRole } : {}) })
      : [];

  const actor: DashboardAuthzActor = {
    userId,
    orgId,
    organizationId: orgId,
    teamIds,
    ...(teamRoles ? { teamRoles } : {}),
    orgRole: orgRole ?? undefined,
    projectGrants: grants.map((g) => ({ projectId: g.projectId, effectiveRole: g.effectiveRole })),
  };
  return { actor, orgId, userId };
}
