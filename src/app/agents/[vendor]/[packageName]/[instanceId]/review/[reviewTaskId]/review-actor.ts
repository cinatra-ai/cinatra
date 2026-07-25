import "server-only";

import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/**
 * Resolve the reviewing principal + org + role hints for the review surface
 * (cinatra#1795 S12 item 4). Builds the `PrimitiveActorContext` from the Better
 * Auth session and the FULL role hints run access consults — resolved through the
 * SAME `requireActorContext` lineage the rest of the app uses, so a reviewer
 * granted run access through org role, a TEAM (`team:<id>`), or a PROJECT
 * (`project:<id>`) run policy is recognized, not falsely denied. The run owner is
 * matched natively by userId. Every review run-access check (read on the page,
 * approveHitl/respondToHitl on submit) enforces against THIS actor + these hints.
 *
 * Returns null when there is no session or no active org — the caller renders the
 * not-authorized panel / redirects (never a live surface for an unauthed viewer).
 */
export async function resolveReviewActorContext(): Promise<ReviewActorContext | null> {
  const session = await getAuthSession();
  if (!session) return null;
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) return null;

  const actor = actorFromSession(session);
  // The fully-resolved kernel actor carries the org/team/project axes run access
  // consults (orgRole, teamIds, teamRoles, projectGrants) — mirror them into the
  // ActorRoleHints the run/gate ports thread into enforceRunAccess. Omit an axis
  // the lineage did not resolve rather than forcing an under-grant.
  const kernel = await requireActorContext();
  const roleHints: ActorRoleHints = {
    ...(kernel.platformRole ? { platformRole: kernel.platformRole } : {}),
    ...(kernel.orgRole ? { orgRole: kernel.orgRole } : {}),
    ...(kernel.teamRoles ? { teamRoles: kernel.teamRoles } : {}),
    ...(kernel.teamIds ? { teamIds: kernel.teamIds } : {}),
    ...(kernel.projectGrants ? { projectGrants: kernel.projectGrants } : {}),
    actorOrganizationId: kernel.organizationId ?? orgId,
  };
  return { actor, orgId, roleHints };
}
