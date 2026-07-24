/**
 * The scope-WRITE gate for the Dashboards-tab collection (cinatra#1897 B4; the
 * ratified design spec at design@bb9230d9b, `specs/app-artifacts.html` §IX.2).
 *
 * This is gate 2 of the collection-add contract (cinatra#1886 C2): "may this
 * actor WRITE (curate) the scope's Dashboards collection". The contract
 * deliberately takes this as an INJECTED decision (`actorMayWriteScope`) rather
 * than guessing a scope-write model — B4/#1897 owns the predicate. This module
 * IS that predicate. It also gates the tab's Add/Remove affordances directly
 * (§IX.2: a member without write authority sees a read-only tab — every row,
 * open-able, but NO Add and NO Remove; suppression, not a disabled control).
 *
 * WHO MAY WRITE — grounded in the shipped scope-authority vocabulary (§IX.2):
 *   - team tab         → a TEAM ADMIN of the team, OR an organization owner/admin
 *                        of the team's org (the shipped team-management authority,
 *                        `canManageTeamMembers`: team admin / org owner-admin /
 *                        platform admin — the same authority that manages the
 *                        team surface manages its collection).
 *   - organization tab → an ORGANIZATION OWNER or ADMIN of that org.
 *   - project tab      → a PROJECT ADMIN or OWNER of that project (the canonical
 *                        project-grant `effectiveRole`, role-by-authority — never
 *                        a blanket owner; `readProjectGrantsForUser`).
 *   - platform_admin   → universal (the scope-ratchet convention: a platform
 *                        admin is not blocked by a target-tier role check).
 *
 * FAIL-CLOSED + TENANT-FENCED. Every arm below is a positive grant; anything
 * unmatched is a denial. The organization-owner/admin arms additionally require
 * the actor's own org to be the scope's org, so an org admin of a DIFFERENT
 * tenant can never write across the boundary (platform_admin is the only
 * cross-tenant writer, deliberately). This is READ-orthogonal: gating who may
 * *curate* the collection is NOT the admin-gated *access* ruling 5 forbids — the
 * dashboards themselves stay open to everyone in scope (§IX.2 success callout).
 *
 * PURE: reads only the `ActorContext` axes (`teamRoles`, `orgRole`,
 * `projectGrants`, `platformRole`, `organizationId`) — no I/O — so it is
 * unit-testable and reusable on both the render gate (suppress Add/Remove) and
 * the mutation gate (authorize add/remove), which MUST agree.
 */
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";

/** True iff the actor holds an org-manager role (owner or admin). */
function isOrgManager(actor: ActorContext): boolean {
  return actor.orgRole === "org_owner" || actor.orgRole === "org_admin";
}

/**
 * May `actor` write (curate) `scope`'s Dashboards collection? See the module
 * header for the exact grant per scope kind. Fail-closed + tenant-fenced.
 */
export function actorMayWriteScope(
  actor: ActorContext,
  scope: ListingScope,
): boolean {
  // Platform admin — universal, cross-tenant (scope-ratchet convention).
  if (actor.platformRole === "platform_admin") return true;

  // The org-manager arms are tenant-fenced: the actor's own org must be the
  // scope's tenant.
  const orgManagerOfScopeTenant =
    isOrgManager(actor) && actor.organizationId === scope.orgId;

  switch (scope.kind) {
    case "team":
      // Team admin of the team, OR an org owner/admin of the team's org. BOTH
      // arms are tenant-fenced: the actor's active org must be the scope's tenant.
      // The team-admin grant is trusted ONLY within the actor's own tenant —
      // `teamRoles` is an active-org projection, so a team_admin key for a team in
      // another tenant must never be a cross-tenant writer (platform_admin is the
      // only deliberate cross-tenant writer, handled above). This mirrors the
      // organization arm's fence so the predicate is UNIFORMLY tenant-closed, and
      // it is defense-in-depth: `removeScopeListing` gates on this predicate alone
      // (codex authz-lens convergence — the team arm previously omitted the fence
      // the docstring's fail-closed/tenant-fenced contract promises).
      if (
        actor.organizationId === scope.orgId &&
        actor.teamRoles?.[scope.scopeId] === "team_admin"
      )
        return true;
      return orgManagerOfScopeTenant;
    case "organization":
      // Org scope: scope.scopeId IS the org being curated. PIN the org-scope
      // invariant (scopeId === orgId) so gate 2 (this predicate) authorizes the
      // SAME org gate 3 (scopeMaySeeRow over scope.scopeId) evaluates — a
      // malformed scope whose orgId disagrees with scopeId is rejected, closing
      // any gate-2/gate-3 cross-tenant gap (codex authz-lens convergence). The
      // actor must be an owner/admin of THAT org.
      return (
        scope.scopeId === scope.orgId &&
        isOrgManager(actor) &&
        actor.organizationId === scope.scopeId
      );
    case "project": {
      // Project admin/owner grant on THIS project (role-by-authority). Project
      // grants are active-org-anchored, so a grant on the project already implies
      // the same tenant.
      const grants = actor.projectGrants ?? [];
      return grants.some(
        (g) =>
          g.projectId === scope.scopeId &&
          (g.effectiveRole === "admin" || g.effectiveRole === "owner"),
      );
    }
    default: {
      // Exhaustive fail-closed: an unknown scope kind is never writable.
      const _exhaustive: never = scope.kind;
      void _exhaustive;
      return false;
    }
  }
}
