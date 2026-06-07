import "server-only";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";
import type { WorkflowActor } from "@cinatra-ai/workflows/scope";

/**
 * Build a release-workflow read-visibility actor from the current session.
 * The tenant boundary (organizationId) is auth-derived (session active org),
 * never a body identifier. Mirrors the /projects RSC pattern.
 */
export async function buildWorkflowActorFromSession(): Promise<{
  actor: WorkflowActor;
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
  const actor: WorkflowActor = {
    organizationId: orgId,
    userId,
    teamIds,
    projectIds: grants.map((g) => g.projectId),
    orgRole: orgRole ?? null,
    // Platform admins must satisfy `canManage` regardless of their org-level
    // `member.role`. `canManage` checks platformRole first; without this
    // populated, platform admins see `canManage === false` on org-level
    // workflows and the lifecycle controls are hidden.
    platformRole: isPlatformAdmin(session) ? "platform_admin" : null,
  };
  return { actor, orgId, userId };
}
