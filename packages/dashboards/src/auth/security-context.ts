/**
 * Better-auth session to Cinatra SecurityContext binding. Used by server
 * components and route handlers that need to query cubes scoped to the
 * caller's org.
 *
 * Cubes filter visibility by every org the user is a member of, not just
 * the active org. The `WithAccessibleOrgIds` variants are async because
 * they query Better Auth's `member` table for the user's full org
 * membership. The sync helpers fall back to `[organizationId]` only to
 * preserve back-compat for callers that have not wired the async path.
 */
import "server-only";
import type { SecurityContext } from "@cinatra-ai/sdk-dashboard";

/** Minimum session shape this helper needs. Avoids importing better-auth types into the dashboards package. */
export type DashboardsSessionLike = {
  readonly user: { readonly id: string } | null;
  readonly session?: {
    readonly activeOrganizationId?: string | null;
  } | null;
};

/**
 * Raw identity to SecurityContext binding. Extracted from
 * `buildSecurityContextFromSession` so the MCP transport, which has no
 * Better Auth session and only receives userId+orgId from
 * `mcpRequestContextStorage`, can build the same SecurityContext shape
 * without faking a session object. The session helper wraps this so all
 * callers converge on a single source of truth.
 *
 * `accessibleOrgIds` defaults to `[organizationId]` here. The async
 * variant (`buildSecurityContextWithAccessibleOrgIds`) queries the Better
 * Auth `member` table to widen the set to every org the user belongs to.
 */
export type DashboardsIdentity = {
  readonly userId: string;
  readonly organizationId: string;
};

export function buildSecurityContextFromIdentity(
  identity: DashboardsIdentity | null | undefined,
): SecurityContext | null {
  if (!identity?.userId || !identity?.organizationId) return null;
  return {
    userId: identity.userId,
    organizationId: identity.organizationId,
    // Minimum-viable default: just the active org. The async variant
    // widens to every org the user belongs to via the Better Auth
    // membership query.
    accessibleOrgIds: [identity.organizationId],
    // Current callers operate at organization scope; workspace and team
    // identifiers are reserved for narrower ownership scopes.
    workspaceId: "",
    teamIds: [],
    ownerLevel: "organization",
  };
}

/**
 * Build a Cinatra SecurityContext from a better-auth session. Returns null
 * when the actor lacks userId or an active organization — callers should
 * treat null as "unauthorized" (redirect to /sign-in OR return 401).
 */
export function buildSecurityContextFromSession(
  session: DashboardsSessionLike | null | undefined,
): SecurityContext | null {
  if (!session?.user?.id) return null;
  const organizationId = session.session?.activeOrganizationId ?? "";
  if (!organizationId) return null;
  return buildSecurityContextFromIdentity({
    userId: session.user.id,
    organizationId,
  });
}

/**
 * Async resolver injection point. Callers pass a
 * `getAccessibleOrgIds(userId)` callback (typically a wrapper over the
 * Better Auth membership query at
 * `src/lib/better-auth-db.ts:listOrganizationMembershipsForUser`). The
 * helper widens the base SecurityContext's `accessibleOrgIds` to the full
 * set returned. Always includes the active `organizationId` (defensive
 * union so the active org is never silently dropped).
 *
 * Used by both transports:
 * - HTTP cubejs route: awaits this in `resolveSecurityContext()`.
 * - MCP cube tools: invokes inside drizzle-cube's `getSecurityContext`
 *   callback (drizzle-cube accepts `SecurityContext | Promise<SecurityContext>`).
 */
export type AccessibleOrgIdsResolver = (userId: string) => Promise<readonly string[]>;

export async function buildSecurityContextWithAccessibleOrgIds(
  identity: DashboardsIdentity | null | undefined,
  getAccessibleOrgIds: AccessibleOrgIdsResolver,
): Promise<SecurityContext | null> {
  const base = buildSecurityContextFromIdentity(identity);
  if (!base) return null;
  let extra: readonly string[];
  try {
    extra = await getAccessibleOrgIds(base.userId);
  } catch {
    // Fail-closed to the active org only — never amplify visibility if
    // the membership query errors. Caller can retry on a future request.
    return base;
  }
  const union = new Set<string>([base.organizationId, ...extra]);
  return { ...base, accessibleOrgIds: Array.from(union) };
}

/**
 * Per-cube visibility resolver bag. Each callback returns the row ids
 * the cube reads in its `WHERE id IN (...)` predicate. All callbacks
 * receive the actor's Cinatra `SecurityContext` (with
 * `accessibleOrgIds` already widened) so they can derive visibility
 * via the existing scope helpers — `actor.projectGrants`,
 * `readTeamsForUser`, `listArtifacts` — without re-implementing
 * sealed-room / project_access / ownership-tier authz inside the
 * cube layer.
 *
 * Three resolvers are wired (one per cube that reads its own
 * visibility-id list — the organizations cube reads `accessibleOrgIds`
 * directly):
 *   - `getVisibleProjectIds` → projects cube.
 *     Source: `actor.projectGrants` (the owned-∪-accessed union).
 *   - `getVisibleTeamIds` → teams cube. Source:
 *     `readTeamsForUser(userId, orgId)` plus optional admin-org
 *     widening from the role-resolution helpers.
 *   - `getVisibleArtifactIds` → artifacts cube. Source:
 *     `listArtifacts({orgId, actor}).map(r => r.artifactId)` — reuses
 *     the existing `listObjectsByFilter` actor-scope path.
 *
 * Every resolver is optional. When omitted, the corresponding
 * visibility field on the resulting SecurityContext stays `undefined`
 * and the matching cube renders zero rows rather than widening the
 * surface.
 */
export type VisibilityResolvers = {
  readonly getVisibleProjectIds?: (
    ctx: SecurityContext,
  ) => Promise<readonly string[]>;
  readonly getVisibleTeamIds?: (
    ctx: SecurityContext,
  ) => Promise<readonly string[]>;
  readonly getVisibleArtifactIds?: (
    ctx: SecurityContext,
  ) => Promise<readonly string[]>;
};

/**
 * Build a SecurityContext with `accessibleOrgIds` widened AND
 * per-cube visibility lists (`visibleProjectIds` / `visibleTeamIds` /
 * `visibleArtifactIds`) pre-computed. Used by the
 * dashboard screens before they mount `<DashboardsClientShell>`.
 *
 * Resolver failures fail closed for THAT resolver only — the matching
 * visibility field stays `undefined` so the cube renders zero rows.
 * The other resolvers and `accessibleOrgIds` widening still apply.
 * This keeps a single misbehaving resolver from collapsing the entire
 * SecurityContext, while never widening visibility past what
 * resolvers successfully proved.
 */
export async function buildSecurityContextWithVisibility(
  identity: DashboardsIdentity | null | undefined,
  getAccessibleOrgIds: AccessibleOrgIdsResolver,
  resolvers: VisibilityResolvers,
): Promise<SecurityContext | null> {
  const widened = await buildSecurityContextWithAccessibleOrgIds(
    identity,
    getAccessibleOrgIds,
  );
  if (!widened) return null;
  const [projects, teams, artifacts] = await Promise.all([
    resolvers.getVisibleProjectIds
      ? resolvers.getVisibleProjectIds(widened).catch(() => undefined)
      : Promise.resolve(undefined),
    resolvers.getVisibleTeamIds
      ? resolvers.getVisibleTeamIds(widened).catch(() => undefined)
      : Promise.resolve(undefined),
    resolvers.getVisibleArtifactIds
      ? resolvers.getVisibleArtifactIds(widened).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  return {
    ...widened,
    visibleProjectIds: projects,
    visibleTeamIds: teams,
    visibleArtifactIds: artifacts,
  };
}
