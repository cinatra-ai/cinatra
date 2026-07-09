/**
 * Shared SecurityContext resolver for the dashboard-cube MCP transport.
 *
 * Both MCP closure sites — `handlers.ts:createDashboardCubeMcpHandlers` AND
 * `registry.ts:registerDashboardCubePrimitives` — build the same
 * `getSecurityContext` closure for drizzle-cube. This module is the single
 * source of truth for that closure so the two sites can never drift.
 *
 * Why this lives in the mcp-cubes module (NOT in `../auth/security-context.ts`):
 * that file sits under the high-risk auth path glob. The MCP transport needs
 * to DECORATE the base SecurityContext with `isPlatformAdmin` — read from a DB
 * role lookup keyed on the actor's userId, because the MCP identity chain
 * carries only `{userId, organizationId}` (never a role). We compose the
 * existing exported `buildSecurityContextWithAccessibleOrgIds` helper here
 * rather than modifying the auth module.
 */
import "server-only";

import type { SecurityContext } from "@cinatra-ai/sdk-dashboard";

import {
  buildSecurityContextFromIdentity,
  buildSecurityContextWithAccessibleOrgIds,
  type AccessibleOrgIdsResolver,
  type DashboardsIdentity,
} from "../auth/security-context";

/** Resolves whether a userId is a platform admin (DB role lookup). */
export type PlatformAdminResolver = (userId: string) => Promise<boolean>;

/** Options for {@link buildDashboardCubeMcpSecurityContext}. */
export type DashboardCubeMcpSecurityContextOptions = {
  /**
   * The active MCP request is an AGENT-RUN OBO delegation (epic #1049 / W4
   * #1053). Dashboard cubes are a cannot-express surface: they resolve no
   * per-row owner, so they cannot honor a sub-org scope ceiling. A NON-org
   * ceiling is already denied at the shared MCP boundary; this flag confines
   * the remaining (org-only-ceiling) agent-run cube reads so they can NEVER
   * widen the security context beyond the run's own org — `accessibleOrgIds` is
   * pinned to `[identity.organizationId]` (no membership widening) and
   * `isPlatformAdmin` is forced `false` (the ceiling is honored BEFORE any
   * admin short-circuit, so a platform-admin invoker gets no cross-org cube
   * visibility for a delegated run). Undefined/false ⇒ unchanged behavior for
   * sessions, dev-bypass, A2A, and chat-delegated callers.
   */
  agentRunObo?: boolean;
};

/**
 * Build the cube SecurityContext for an MCP request: widen
 * `accessibleOrgIds` to the user's full org membership (so the agent_runs /
 * org-scoped cubes see multi-org rows) AND decorate `isPlatformAdmin` from
 * an explicit by-userId role lookup (so the `llm_usage` cube's fail-closed
 * visibility gate works for admins).
 *
 * EXCEPTION — agent-run OBO (`options.agentRunObo`): confine the run to its own
 * org. Skip BOTH the membership widening and the platform-admin decoration and
 * return a context pinned to `[identity.organizationId]` with
 * `isPlatformAdmin: false`, so a delegated run can never widen a cube beyond the
 * run org regardless of the invoker's other memberships or admin role.
 *
 * Returns `null` when identity is incomplete (surfaces as the cube tools'
 * `isError` envelope). The platform-admin lookup fails closed to `false` —
 * a thrown lookup never widens visibility past a non-admin.
 */
export async function buildDashboardCubeMcpSecurityContext(
  identity: DashboardsIdentity | null | undefined,
  getAccessibleOrgIds: AccessibleOrgIdsResolver,
  getIsPlatformAdmin: PlatformAdminResolver,
  options?: DashboardCubeMcpSecurityContextOptions,
): Promise<SecurityContext | null> {
  if (options?.agentRunObo) {
    // Confine a delegated agent run to its own org: build the base context
    // directly from identity (`accessibleOrgIds` defaults to `[organizationId]`)
    // WITHOUT invoking the membership-widening or platform-admin resolvers, then
    // re-pin defensively and drop admin visibility.
    const pinned = buildSecurityContextFromIdentity(identity);
    if (!pinned) return null;
    return {
      ...pinned,
      accessibleOrgIds: [pinned.organizationId],
      isPlatformAdmin: false,
    };
  }
  const base = await buildSecurityContextWithAccessibleOrgIds(
    identity,
    getAccessibleOrgIds,
  );
  if (!base) return null;
  let isPlatformAdmin = false;
  try {
    isPlatformAdmin = await getIsPlatformAdmin(base.userId);
  } catch {
    // Fail-closed: never amplify visibility if the role lookup errors.
    isPlatformAdmin = false;
  }
  return { ...base, isPlatformAdmin };
}
