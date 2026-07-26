/**
 * Sealed-room project READ gate (cinatra#1898 ACL cutover / #2064).
 *
 * A project is NEVER an ownership tier; read access is N:M via `project_access`
 * (owned ∪ accessed). The CANONICAL read gate for a project surface is therefore
 * "does the actor hold a resolved project grant for THIS project?", where the
 * grant set is the one the canonical resolver `readProjectGrantsForUser`
 * produces (Source 1 implicit-owned incl. org-owned member read, Source 2
 * explicit `project_access` incl. org-/team-level grants expanded to their
 * members, Source 3 back-compat co-owner). That resolved set is carried on the
 * `ActorContext.projectGrants` axis by `getActorContext` /
 * `requireActorContext`.
 *
 * This is deliberately NOT the kernel `can(project.read)` path: the `member`
 * role grants blanket `project.read` org-wide (see `policies.ts`), so a
 * `can()`-based gate would let ANY org member read ANY project — defeating the
 * sealed-room model the ratified `/projects/[id]/dashboards` route, the
 * `/projects` cube (`visibleProjectIds`), and the `/artifacts` project-scoped
 * dashboard all already enforce via this SAME resolved-grant source. Keeping the
 * predicate here lets every project READ surface gate identically so they cannot
 * drift.
 */
import type { ActorContext } from "./actor-context";

/**
 * True iff `actor` holds a resolved project grant (any role — read is the floor)
 * for `projectId`. The caller must have resolved the actor via
 * `getActorContext` / `requireActorContext` so `projectGrants` is populated;
 * an unresolved (`undefined`) axis fails closed to `false`.
 */
export function actorHoldsProjectGrant(
  actor: Pick<ActorContext, "projectGrants">,
  projectId: string,
): boolean {
  return (actor.projectGrants ?? []).some((g) => g.projectId === projectId);
}
