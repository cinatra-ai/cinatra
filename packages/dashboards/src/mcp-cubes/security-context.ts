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
  buildSecurityContextWithAccessibleOrgIds,
  type AccessibleOrgIdsResolver,
  type DashboardsIdentity,
} from "../auth/security-context";

/** Resolves whether a userId is a platform admin (DB role lookup). */
export type PlatformAdminResolver = (userId: string) => Promise<boolean>;

/**
 * Build the cube SecurityContext for an MCP request: widen
 * `accessibleOrgIds` to the user's full org membership (so the agent_runs /
 * org-scoped cubes see multi-org rows) AND decorate `isPlatformAdmin` from
 * an explicit by-userId role lookup (so the `llm_usage` cube's fail-closed
 * visibility gate works for admins).
 *
 * Returns `null` when identity is incomplete (surfaces as the cube tools'
 * `isError` envelope). The platform-admin lookup fails closed to `false` —
 * a thrown lookup never widens visibility past a non-admin.
 */
export async function buildDashboardCubeMcpSecurityContext(
  identity: DashboardsIdentity | null | undefined,
  getAccessibleOrgIds: AccessibleOrgIdsResolver,
  getIsPlatformAdmin: PlatformAdminResolver,
): Promise<SecurityContext | null> {
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
