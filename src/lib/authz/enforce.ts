/**
 * Authorization kernel — enforcement predicate, session adapter, and
 * convenience wrapper.
 *
 * The ONLY file in src/lib/authz/ that imports `server-only`. All other
 * authz files are pure types/data and tier-agnostic.
 *
 * IMPORTANT: This module must NOT import `@/lib/auth`. Doing so would
 * create a circular boot dependency — `auth.ts` does top-level await on
 * `getGoogleOAuthSettings()` which transitively imports from
 * `@cinatra-ai/google-oauth-connection`. We accept the session as input via
 * the structural `BetterAuthSessionLike` type below.
 */
import "server-only";

import {
  POLICY_VERSION,
  type ActorContext,
  type ProjectGrant,
} from "./actor-context";
import { AuthzError } from "./errors";
import type { Permission } from "./permissions";
import type { ResourceRef } from "./resource-ref";
import { roleHasPermission, type Role } from "./policies";

/**
 * Empty extensible interface for future evaluation inputs such as
 * delegation-chain depth limits, time-bounded grants, A2A-task-scoped
 * overrides, etc.
 */
export type EvaluationContext = Record<never, never>;

/**
 * Structural subset of Better Auth's session — captures only the fields
 * `buildActorContext` actually reads. NOT a runtime import from
 * @/lib/auth.
 */
type BetterAuthSessionLike = {
  user: { id: string; role?: string | null };
  session: { activeOrganizationId?: string | null };
};

/**
 * Resolve the set of roles an actor has IN THE CONTEXT of the given
 * resource. Cross-org actors get no org/team roles. Synthetic roles
 * (service_account, external_agent) come from principalType and are
 * gated on org-match.
 *
 * `InternalWorker` and `System` principal types intentionally have NO
 * synthetic-role mapping here. Background workers and system callers
 * MUST construct their ActorContext with an explicit `platformRole`
 * (typically `"platform_admin"` for trust-the-calling-code paths) or
 * with explicit `orgRole`/`teamRoles` they have already resolved.
 * Leaving the mapping silent would either (a) silently grant everything
 * — a tenant-isolation hole — or (b) silently deny everything, which
 * downstream callers would paper over with `platform_admin` overrides
 * defeating the purpose. The explicit contract is: callers of an
 * InternalWorker/System actor are responsible for the role bag, and a
 * unit test below locks it in.
 */
function resolveRoles(actor: ActorContext, resource: ResourceRef): Role[] {
  const roles: Role[] = [];
  if (actor.platformRole === "platform_admin") {
    roles.push("platform_admin");
  }
  // Org roles only apply when actor and resource share an org.
  if (resource.organizationId && actor.organizationId === resource.organizationId) {
    if (actor.orgRole === "org_owner") roles.push("org_owner");
    if (actor.orgRole === "org_admin") roles.push("org_admin");
    if (actor.orgRole === "member") roles.push("member");
  }
  // Team admin only if actor administers the resource's owning team.
  if (
    resource.ownerType === "team" &&
    resource.ownerId &&
    actor.teamRoles?.[resource.ownerId] === "team_admin"
  ) {
    roles.push("team_admin");
  }
  // Synthetic roles derived from principal type. Gate on the same
  // org-match condition as org/team roles so an org-less or mismatched
  // service account / external agent does not get a global authority
  // for `agent.execute` and `run.read`. Org-less resources (the
  // "platform" sentinel) intentionally skip this so synthetic principals
  // can still answer resource-less checks against their own scope —
  // the cross-org guard above already denies non-matching org-scoped
  // resources.
  const sameOrg =
    resource.organizationId !== undefined &&
    actor.organizationId === resource.organizationId;
  if (sameOrg) {
    if (actor.principalType === "ServiceAccount") roles.push("service_account");
    if (actor.principalType === "ExternalA2AAgent") roles.push("external_agent");
  }
  // Per-scope role grants are resolved into `actor.roles` by the
  // better-auth → ActorContext bridge (developer / release_manager /
  // customer). The grants are scoped to the resource's owning scope; the
  // kernel still applies the cross-org guard above. Only known Roles are
  // admitted to prevent runtime drift.
  const extra = (actor as ActorContext & { roles?: string[] }).roles;
  if (Array.isArray(extra) && sameOrg) {
    const known: ReadonlySet<string> = new Set([
      "developer",
      "release_manager",
      "customer",
    ]);
    for (const r of extra) {
      if (known.has(r) && !roles.includes(r as Role)) roles.push(r as Role);
    }
  }
  return roles;
}

/**
 * Pure predicate. Never throws. Returns boolean.
 *
 * Algorithm:
 *   1. If resource has an org and actor's org differs and actor is NOT
 *      platform_admin, deny (cross-org guard).
 *   2. Resolve the actor's effective roles for this resource.
 *   3. Union the EFFECTIVE_GRANTS for those roles; allow if action ∈ union.
 */
export function can(
  actor: ActorContext,
  action: Permission,
  resource: ResourceRef,
  _context?: EvaluationContext,
): boolean {
  // Cross-org guard. If the resource is org-scoped and the actor's org
  // does not equal the resource's org (including the actor having no
  // org at all), deny — unless the actor is platform_admin. Treating
  // `actor.organizationId === undefined` as "not in this org" is the
  // intended fail-closed semantic for any org-scoped resource. Resources
  // without an organizationId (e.g. the "platform" sentinel) skip this
  // check.
  if (
    resource.organizationId !== undefined &&
    actor.organizationId !== resource.organizationId &&
    actor.platformRole !== "platform_admin"
  ) {
    return false;
  }

  const roles = resolveRoles(actor, resource);
  for (const role of roles) {
    if (roleHasPermission(role, action)) return true;
  }
  return false;
}

/**
 * Session-shaped wrapper around `can()`. When no resource is passed,
 * synthesizes a "platform" sentinel ref scoped to the session's active
 * org — used for resource-less checks like "can this user open
 * administration at all?".
 */
export function canDo(
  session: BetterAuthSessionLike | null | undefined,
  action: Permission,
  resource?: ResourceRef,
  opts?: {
    teamIds?: string[];
    teamRoles?: Record<string, "team_admin" | "member">;
    orgRole?: "org_owner" | "org_admin" | "member";
  },
): boolean {
  // Fail closed on missing session. Server actions and route handlers
  // following Better Auth's idiomatic pattern receive Session | null
  // and a forgotten `if (!session) ...` guard would otherwise yield an
  // uncaught TypeError.
  if (!session?.user?.id) return false;
  const actor = buildActorContext(session, opts);
  // The synthetic resource intentionally co-locates with the actor's
  // own organizationId so org-scoped permissions (e.g. settings.update)
  // are evaluated against the actor's own org. Callers that want to
  // gate a cross-org platform action must pass an explicit ResourceRef
  // with `organizationId: undefined`.
  const ref: ResourceRef = resource ?? {
    resourceType: "platform",
    resourceId: "*",
    organizationId: actor.organizationId,
  };
  return can(actor, action, ref);
}

/**
 * Construct an ActorContext from a Better Auth session.
 *
 * Re-uses the EXACT comma-split admin-role parsing pattern from
 * src/lib/auth-session.ts:60-67. Better Auth admin plugin stores roles
 * as a comma-separated string ("user,admin") — naive `=== "admin"`
 * checks miss those.
 *
 * IMPORTANT: this parser is pinned to the comma-separated-string
 * encoding used by `better-auth` ^1.6.9 (admin plugin). If the upstream
 * encoding changes (JSON array, semicolon-separated, native string[],
 * etc.) every admin user is silently demoted to "member" — fail-closed,
 * but a silent regression. Re-validate this branch against the upstream
 * admin plugin source on every Better Auth version bump and add a
 * fixture for the new shape.
 *
 * `organizationId` is set from `session.session.activeOrganizationId`
 * but coerced from `null` to `undefined`; activeOrganizationId can be
 * null for new accounts.
 *
 * `teamRoles` are caller-provided in `opts`; this function does NOT read
 * `cinatra.organization_member` from the DB.
 *
 * `orgRole` defaults to "member" but is overridable through `opts.orgRole`
 * so callers that have already resolved the user's org membership can
 * pass it in. This function does not detect org_admin/org_owner from the
 * DB.
 */
export function buildActorContext(
  session: BetterAuthSessionLike | null | undefined,
  opts?: {
    teamIds?: string[];
    teamRoles?: Record<string, "team_admin" | "member">;
    orgRole?: "org_owner" | "org_admin" | "member";
    /**
     * Resolved-vs-unresolved rule: `buildActorContext` is SYNC and resolves
     * no DB state itself. It sets `projectGrants` ONLY when this is supplied
     * (the async session-lineage resolvers
     * `getActorContext` / `requireActorContext` / `resolveUserContextForUserId`
     * resolve grants via `readProjectGrantsForUser` and pass them here —
     * possibly `[]`). When absent it leaves `projectGrants` **undefined**
     * ("not resolved", NOT `[]` which means "resolved, none"). Direct sync
     * callers that never needed project visibility (notifications-host.ts,
     * hitl-assist/route.ts, internal requireResourceAccess) stay
     * undefined/legacy — no behavior change. `projectIds` is derived
     * (single derivation) only when `projectGrants !== undefined`.
     */
    projectGrants?: ProjectGrant[];
  },
): ActorContext {
  // Throw the documented 401 error rather than letting `session.user`
  // raise an uncaught TypeError.
  if (!session?.user?.id) {
    throw new AuthzError({
      statusCode: 401,
      reason: "no_session",
      message: "buildActorContext called with no session",
    });
  }
  const isPlatformAdmin = String(session.user.role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes("admin");

  const platformRole: "platform_admin" | "member" = isPlatformAdmin
    ? "platform_admin"
    : "member";

  // Resolved-vs-unresolved: `projectGrants` is set ONLY when the caller
  // resolved and supplied it (possibly `[]`). Otherwise BOTH `projectGrants`
  // and the derived `projectIds` stay `undefined` ("not resolved"). Single
  // derivation: `projectIds = projectGrants.map(g => g.projectId)`, sorted.
  const projectFields:
    | { projectGrants: ProjectGrant[]; projectIds: string[] }
    | Record<string, never> =
    opts?.projectGrants !== undefined
      ? {
          projectGrants: opts.projectGrants,
          projectIds: opts.projectGrants
            .map((g) => g.projectId)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        }
      : {};

  return {
    principalType: "HumanUser",
    principalId: session.user.id,
    organizationId: session.session?.activeOrganizationId ?? undefined,
    teamIds: opts?.teamIds,
    teamRoles: opts?.teamRoles,
    platformRole,
    orgRole: opts?.orgRole ?? "member",
    authSource: "ui",
    policyVersion: POLICY_VERSION,
    ...projectFields,
  };
}
