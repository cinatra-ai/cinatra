/**
 * Generic CRUD authorization gate.
 *
 * `enforceResourceAccess` is the single helper that gates every CRUD
 * entrypoint touching `cinatra.objects` or `cinatra.projects` (and any
 * future generic resource that follows the four-tier ownership model).
 * It subsumes the run-specific `enforceRunAccess` shape, with the
 * run-only layers (token-scope intersection + AgentAuthPolicy
 * tightening) staying in `packages/agent-builder/src/auth-policy.ts`.
 *
 * No `import "server-only"` — only
 * `enforce.ts` carries that guard inside `src/lib/authz/`.
 * always pass `resource.organizationId` even for user-owned resources
 * so the kernel cross-org guard can fire.
 *
 * Co-owner short-circuit fires only on the read /
 * update / manageMembers ops; project.delete is owner-only.
 */

// Imports go through the `@/lib/authz` barrel (not the sub-files directly)
// so test-time `vi.spyOn(authz, "can")` calls in callers like
// enforceRunAccess intercept the kernel decision.
import * as authz from "@/lib/authz";
import { AuthzError } from "./errors";
import { buildActorContextFromPrimitive } from "./build-actor-context";
import type { Permission } from "./permissions";
import type { ResourceRef, OwnerLevel, OwnerType, Visibility } from "./resource-ref";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "./build-actor-context";

/**
 * Resource envelope consumed by the helper. The `resourceType` union
 * intentionally accepts `"run"` so the run-specific
 * `enforceRunAccess` can wrap this generic helper without
 * branching on a separate shape.
 *
 * `"registry"` supports installRegistryPackageAtScope; the
 * kernel does not consult resourceType for the decision (only ownerLevel +
 * ownerId via ownerLevelToType()), so this widening is behaviorally inert
 * for existing call sites — only carried as audit/observability metadata.
 */
export type ResourceForAccessCheck = {
  resourceType: "object" | "project" | "run" | "registry";
  resourceId: string;
  organizationId: string | null;
  ownerLevel: OwnerLevel;
  ownerId: string;
  visibility: Visibility | null;
  /**
   * Optional list of co-owner user ids. Populated by the caller when the
   * resource carries a co-owner table (projects, runs); absent for
   * resources that have no co-ownership concept (objects).
   */
  coOwnerUserIds?: string[];
};

/**
 * Co-owner short-circuit op set for projects.
 *
 * Co-owners get equal rights to
 * READ, UPDATE, and MANAGE MEMBERS. They do NOT inherit the
 * destructive `project.delete` capability — that stays owner-only so
 * the original owner retains the final destructive say. The same set
 * applies for object-level co-ownership if that model is introduced.
 *
 * `run.*` permissions are intentionally absent here: the run helper
 * keeps its own COOWNER_OPS set in agent-builder (it includes share /
 * cancel / etc., which the projects model does not).
 */
const RESOURCE_COOWNER_OPS: ReadonlySet<Permission> = new Set<Permission>([
  "project.read",
  "project.update",
  "project.manageMembers",
  "object.read",
  "object.update",
]);

/**
 * Map an OwnerLevel onto the kernel's ResourceRef.ownerType.
 * The two unions intentionally diverge — OwnerLevel includes
 * `workspace` and `project` (UI-tier concepts) that the kernel does not
 * track at the role-resolution layer. Map them onto `organization` so
 * `can()` evaluates them against org-level grants; finer-grained
 * workspace/project gating is handled at the data-fetch layer.
 */
function ownerLevelToType(level: OwnerLevel): OwnerType {
  switch (level) {
    case "user":
      return "user";
    case "team":
      return "team";
    case "organization":
    case "workspace":
      return "organization";
  }
}

/**
 * Translate the loose `actor.roles` payload (string | string[] | comma-
 * separated) into ActorRoleHints. Convention:
 *   - "platform_admin"             → platformRole = platform_admin
 *   - "owner"                      → orgRole = org_owner
 *   - "admin"                      → orgRole = org_admin
 *   - "member"                     → orgRole = member
 *
 * Better Auth's admin plugin encodes platform-admin as `"admin"` inside
 * a comma-string, while test fixtures use the unambiguous
 * `"platform_admin"` literal, so the mapping above keeps the layers
 * separated.
 */
function deriveRoleHints(actor: PrimitiveActorContext): ActorRoleHints {
  const raw = (actor as unknown as { roles?: unknown }).roles;
  const rawTeamRoles = (actor as unknown as { teamRoles?: unknown }).teamRoles;

  const roles: string[] = (() => {
    if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === "string");
    if (typeof raw === "string")
      return raw
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    return [];
  })();

  let platformRole: ActorRoleHints["platformRole"];
  let orgRole: ActorRoleHints["orgRole"];

  for (const r of roles) {
    if (r === "platform_admin") platformRole = "platform_admin";
    else if (r === "owner") orgRole = "org_owner";
    else if (r === "admin" && !platformRole) orgRole = "org_admin";
    else if (r === "member" && !orgRole) orgRole = "member";
  }

  // MCP-actor compatibility: actors stamped by the MCP transport (chat-OBO,
  // agent-run-OBO, OAuth bearer paths) carry `platformRole` directly on the
  // envelope rather than encoded in `roles[]`. `actorFromSession` is the
  // ONLY producer that populates `roles` (from `user.role`); every MCP
  // registry stamps `platformRole` instead. Without this fallback, every
  // non-cookie MCP path silently loses platform_admin status crossing into
  // the kernel.
  //
  // Live regression (2026-05-23, Apollo end-to-end campaign): the bridge's
  // run-scoped OBO actor had `platformRole: "platform_admin"` (resolved
  // live via `resolveAgentRunMcpActor`), userId, orgId all set — but
  // `objects_save` threw `Access denied.` on `object.create` because
  // `deriveRoleHints` returned `{platformRole: undefined}` and the kernel
  // saw no admin signal. Same hole hit every MCP-relayed agent making any
  // `*.create / *.update / *.delete` call.
  if (!platformRole) {
    const direct = (actor as unknown as { platformRole?: unknown })
      .platformRole;
    if (direct === "platform_admin" || direct === "member") {
      platformRole = direct;
    }
  }

  let teamRoles: ActorRoleHints["teamRoles"];
  if (rawTeamRoles && typeof rawTeamRoles === "object") {
    teamRoles = {};
    for (const [k, v] of Object.entries(rawTeamRoles as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      if (v === "admin" || v === "team_admin") teamRoles[k] = "team_admin";
      else if (v === "member") teamRoles[k] = "member";
    }
  }

  // The actor's own org id (for the kernel cross-org guard) — read from
  // either `actor.organizationId` or the legacy `actor.orgId` test
  // fixture field.
  const actorOrgId =
    (actor as unknown as { organizationId?: string | null }).organizationId ??
    (actor as unknown as { orgId?: string | null }).orgId ??
    undefined;

  return {
    platformRole,
    orgRole,
    teamRoles,
    actorOrganizationId: actorOrgId,
  };
}

/**
 * Generic resource-access gate.
 *
 * Status-code policy (mirrors enforceRunAccess):
 *   - resource is null/undefined          → 404 hidden     (don't leak existence)
 *   - actor is null/undefined             → 403 forbidden  (no anonymous access)
 *   - actor present + can() === false     → 403 forbidden  (decision denial)
 *
 * Algorithm:
 *   1. Owner short-circuit (user-owned resources only).
 *   2. Co-owner short-circuit (read/update/manageMembers only).
 *   3. Kernel `can()` — applies cross-org guard + role-grant union.
 */
export async function enforceResourceAccess(
  resource: ResourceForAccessCheck | null | undefined,
  actor: PrimitiveActorContext | null | undefined,
  op: Permission,
  /**
   * Optional pre-resolved role hints. When supplied, these win over any
   * roles inferred from `actor.roles` / `actor.teamRoles` so call sites
   * that have already resolved Better Auth admin / org / team roles
   * (e.g. `enforceRunAccess` forwarding ActorRoleHints) reach the kernel
   * with their canonical role bag intact. Without this channel,
   * platform_admin actors silently lose admin
   * status crossing the bridge.
   */
  roleHintsOverride?: ActorRoleHints,
): Promise<void> {
  if (!resource) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Not found.",
    });
  }
  if (!actor) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Access denied.",
    });
  }

  // 1. Owner short-circuit — user-owned resources always allow the owner.
  if (
    resource.ownerLevel === "user" &&
    actor.userId !== undefined &&
    actor.userId === resource.ownerId
  ) {
    return;
  }

  // 2. Co-owner short-circuit — read/update/manageMembers only.
  if (
    actor.userId !== undefined &&
    resource.coOwnerUserIds &&
    resource.coOwnerUserIds.includes(actor.userId) &&
    RESOURCE_COOWNER_OPS.has(op)
  ) {
    return;
  }

  // 2b. Team-owner short-circuit — team admins of the owning team get
  //     equal-rights authority over team-owned resources. This is the
  //     team analogue of the user-owner short-circuit above. Without it,
  //     the kernel only grants team_admin `agent.share` + `skill.assign`
  //     (plus inherited member reads), so legitimate team admins would
  //     be denied UPDATE / DELETE on their own team's projects/objects.
  if (resource.ownerLevel === "team") {
    const rawTeamRoles = (actor as unknown as { teamRoles?: unknown }).teamRoles;
    if (rawTeamRoles && typeof rawTeamRoles === "object") {
      const role = (rawTeamRoles as Record<string, unknown>)[resource.ownerId];
      if (role === "admin" || role === "team_admin") return;
    }
  }

  // 3. Kernel decision.
  const derivedHints = deriveRoleHints(actor);
  // The override merge must preserve
  // `projectGrants` (the canonical axis). When grants are present, derive
  // `projectIds` from them as the single source of truth; only fall back to
  // the explicit `projectIds` override when grants are NOT supplied (legacy
  // path). Without this, every generic authz path that hits this merge
  // silently loses the projectGrants the canonical resolver populated.
  const mergedProjectGrants = roleHintsOverride
    ? roleHintsOverride.projectGrants ?? derivedHints.projectGrants
    : undefined;
  const roleHints: ActorRoleHints = roleHintsOverride
    ? {
        platformRole: roleHintsOverride.platformRole ?? derivedHints.platformRole,
        orgRole: roleHintsOverride.orgRole ?? derivedHints.orgRole,
        teamRoles: roleHintsOverride.teamRoles ?? derivedHints.teamRoles,
        teamIds: roleHintsOverride.teamIds,
        projectGrants: mergedProjectGrants,
        projectIds:
          mergedProjectGrants !== undefined
            ? mergedProjectGrants.map((g) => g.projectId)
            : roleHintsOverride.projectIds,
        // Only let the override replace the derived org id when it
        // has a concrete value. A `null` override means "caller did not
        // know the org" — we must NOT clobber the derived (actor-side) org
        // with null because then the kernel cross-org guard cannot fire.
        // Treat both `undefined` and `null` as "fall through to derived"
        // so the actor's authenticated org is always present when known.
        actorOrganizationId:
          roleHintsOverride.actorOrganizationId != null
            ? roleHintsOverride.actorOrganizationId
            : derivedHints.actorOrganizationId,
      }
    : derivedHints;
  const safeActor: PrimitiveActorContext = {
    // Default to the most-restrictive actor tier. A caller that
    // forgot to populate `actorType` should NOT be silently upgraded to
    // `"human"` (which carries broader trust); fall back to `"system"`
    // (InternalWorker) so the kernel applies the strictest grants.
    actorType: actor.actorType ?? "system",
    source: actor.source ?? "ui",
    userId: actor.userId,
    sessionId: actor.sessionId,
    requestId: actor.requestId,
    campaignId: actor.campaignId,
    provider: actor.provider,
    model: actor.model,
    jobId: actor.jobId,
    operationId: actor.operationId,
    approvedByUserId: actor.approvedByUserId,
    tokenScopes: actor.tokenScopes,
  };
  const actorContext = buildActorContextFromPrimitive(
    safeActor,
    resource.organizationId ?? null,
    roleHints,
  );

  // Always pass organizationId even for user-owned resources
  // so the kernel cross-org guard can fire.
  const ref: ResourceRef = {
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    organizationId: resource.organizationId ?? undefined,
    ownerType: ownerLevelToType(resource.ownerLevel),
    ownerId: resource.ownerId,
    visibility: resource.visibility ?? undefined,
    level: resource.ownerLevel,
  };

  if (!authz.can(actorContext, op, ref)) {
    // For `*.read` permissions, downgrade the deny to a 404-hidden
    // response so a probing caller cannot enumerate which resource ids
    // exist by distinguishing 403 (exists, denied) from 404 (does not
    // exist). Mutating ops keep 403 because the caller already had to
    // discover the id via a successful read path.
    const hideExistence = op.endsWith(".read");
    throw new AuthzError({
      statusCode: hideExistence ? 404 : 403,
      reason: hideExistence ? "hidden" : "forbidden",
      message: hideExistence ? "Not found." : "Access denied.",
    });
  }
}
