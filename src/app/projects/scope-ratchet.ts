/**
 * Scope ratchet guard.
 *
 * Ownership-level promotion (user -> team -> organization -> workspace) is
 * one-way: projects can move upward through the ownership levels, but they
 * are never downgraded. This module is the single enforcement point for that
 * rule on project resources.
 *
 * Authorization rules:
 *   - target === current                           -> noop
 *   - target tier rank LESS THAN current rank      -> throw (downgrade)
 *   - target === "team"                            -> actor must be team_admin of targetOwnerId
 *   - target === "organization"                    -> actor must be org_admin/org_owner of targetOwnerId
 *   - target === "workspace"                       -> actor must be platform_admin
 *
 * The guard intentionally lives outside `src/lib/authz/` because the
 * "scope ratchet" is a project-scoped UX rule layered on top of the
 * generic kernel decisions. The kernel's `can()` does not carry a
 * silent platform_admin write bypass: resource-CRUD grants are absent
 * from `platform_admin` DIRECT_GRANTS in `src/lib/authz/policies.ts`.
 * The scope-ratchet still applies on top for the cases where org_admin /
 * team_admin / owner reaches it: a downgrade is rejected regardless of
 * role, and a promotion to a tier the actor does not hold is rejected.
 *
 * For the current platform-admin powers convention, see
 * https://docs.cinatra.ai/references/platform/authz-admin-powers/.
 */

import { AuthzError } from "@/lib/authz/errors";
import type { OwnerLevel } from "@/lib/authz/resource-ref";

type ActorLike = {
  userId?: string | null;
  roles?: string[] | string | null;
  teamRoles?: Record<string, string> | null;
  // Tolerate fixture shorthand fields used in authorization tests.
  orgId?: string | null;
  organizationId?: string | null;
};

export type ScopeRatchetInput = {
  from: { ownerLevel: OwnerLevel; ownerId: string };
  to:   { ownerLevel: OwnerLevel; ownerId: string };
  actor: ActorLike | null | undefined;
};

const RANK: Record<OwnerLevel, number> = {
  user: 0,
  team: 1,
  organization: 2,
  workspace: 3,
};

function deny(message: string): never {
  throw new AuthzError({ statusCode: 403, reason: "forbidden", message });
}

function rolesOf(actor: ActorLike): string[] {
  const raw = actor.roles;
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === "string");
  if (typeof raw === "string") return raw.split(",").map((r) => r.trim()).filter(Boolean);
  return [];
}

function isPlatformAdmin(actor: ActorLike): boolean {
  // Callers should translate Better Auth's `"admin"` literal on
  // `session.user.role` to `"platform_admin"` at the bridge (see
  // `actorFromSession` in src/app/projects/actions.ts). Org-level
  // `"admin"` lives in the `public.member` table and is not present on
  // `user.role`, so the canonical literal is the only one this guard
  // needs to recognise. Bridges that fail to translate will not trigger
  // this guard; that is intentional, to avoid conflating org-admin and
  // platform-admin if the convention ever changes.
  return rolesOf(actor).includes("platform_admin");
}

function isOrgAdmin(actor: ActorLike, orgId: string): boolean {
  // Org membership is implicit via the actor's `orgId` / `organizationId`.
  // We require the actor to be in that org AND hold an admin/owner role.
  const actorOrg = actor.orgId ?? actor.organizationId ?? null;
  if (actorOrg !== orgId) return false;
  const roles = rolesOf(actor);
  return roles.includes("owner") || roles.includes("admin") || roles.includes("org_admin") || roles.includes("org_owner");
}

function isTeamAdmin(actor: ActorLike, teamId: string): boolean {
  const tr = actor.teamRoles;
  if (!tr || typeof tr !== "object") return false;
  const role = tr[teamId];
  return role === "admin" || role === "team_admin";
}

/**
 * Throws AuthzError(403) when:
 *   - the requested transition is a downgrade (any decrease in rank); or
 *   - the actor lacks the role required to write at the target tier.
 *
 * Returns void (resolves) on no-op (target === current) or on a valid
 * promotion.
 */
export async function assertScopeRatchet(input: ScopeRatchetInput): Promise<void> {
  const { from, to, actor } = input;

  if (!actor) {
    deny("Scope ratchet requires an authenticated actor.");
  }

  // Same-tier transitions only allowed when ownerId is unchanged. A
  // sideways move (e.g. team-A -> team-B) is not a ratchet; reject.
  if (from.ownerLevel === to.ownerLevel) {
    if (from.ownerId === to.ownerId) return;
    deny("Sideways ownership transfer is not allowed via scope ratchet.");
  }

  // Downgrade; ownership promotions are irreversible.
  if (RANK[to.ownerLevel] < RANK[from.ownerLevel]) {
    deny(`Cannot demote ownership from ${from.ownerLevel} to ${to.ownerLevel} — promotions are irreversible.`);
  }

  // Promotion: check the actor's role at the TARGET level.
  // platform_admin bypasses target-role checks below "workspace".
  if (isPlatformAdmin(actor)) return;

  switch (to.ownerLevel) {
    case "team":
      if (!isTeamAdmin(actor, to.ownerId)) {
        deny(`Promotion to team ${to.ownerId} requires team_admin role at the target team.`);
      }
      return;
    case "organization":
      if (!isOrgAdmin(actor, to.ownerId)) {
        deny(`Promotion to organization ${to.ownerId} requires org_admin role at the target organization.`);
      }
      return;
    case "workspace":
      // Only platform_admin can hand a project to the workspace tier;
      // we already returned above for platform_admin actors.
      deny("Promotion to workspace tier requires platform_admin.");
      // unreachable: `deny` always throws. Keep an explicit return so a
      // future refactor that softens `deny` cannot fall through.
      return;
    case "user":
      // user is rank 0; only reachable when from === to (handled above).
      return;
    default: {
      // Exhaustive guard. Any new OwnerLevel addition fails here at
      // compile time, and any unknown runtime string is rejected as a
      // defense against unvalidated client input.
      const _exhaustive: never = to.ownerLevel;
      deny(`Unsupported target ownership level: ${String(_exhaustive)}`);
    }
  }
}
