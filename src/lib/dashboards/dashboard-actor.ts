// Build a dashboards read-visibility actor from the current session.
// Mirrors `buildWorkflowActorFromSession`, but carries the FULL `projectGrants`
// (projectId + effectiveRole) the dashboards read-visibility resolver needs — not just projectIds.
import "server-only";

import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";
import type { DashboardAuthzActor } from "@/lib/dashboards/authz";

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
    orgRole: orgRole ?? undefined,
    projectGrants: grants.map((g) => ({ projectId: g.projectId, effectiveRole: g.effectiveRole })),
  };
  return { actor, orgId, userId };
}
