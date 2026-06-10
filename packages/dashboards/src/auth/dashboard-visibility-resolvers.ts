/**
 * Concrete visibility resolvers for the dashboards cubes.
 *
 * Each resolver maps the Cinatra `SecurityContext` to the id-list the
 * matching cube reads in its `WHERE id IN (...)` predicate. The resolvers
 * delegate to the existing scope helpers (`readProjectGrantsForUser`,
 * `readTeamsForUser`, `listArtifacts`) so authz logic stays in one place
 * and the cube layer never re-implements sealed-room / project_access /
 * ownership-tier semantics.
 *
 * Used by:
 *   - `src/app/api/dashboards/cubejs-api/v1/[...endpoint]/route.ts` —
 *     widens every cube query to the actor's visible-id lists. This is the
 *     ONLY current consumer: the dashboard screens build a plain session
 *     SecurityContext and rely on this route for cube data, so the
 *     visibility surface is computed in exactly one place.
 */
import "server-only";
import type { SecurityContext } from "@cinatra-ai/sdk-dashboard";

import {
  listTeamsForOrg,
  readProjectGrantsForUser,
  readTeamsForUser,
} from "@/lib/better-auth-db";
import {
  getActorContext,
  resolveOrgRoleForSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { getAuthSession } from "@/lib/auth-session";
import { listArtifacts } from "@/lib/artifacts/artifact-service";

import type { VisibilityResolvers } from "./security-context";
import { resolveVisibleTeamIds } from "./team-visibility";

/**
 * Compute the actor's accessible project IDs. Resolved via the canonical
 * `readProjectGrantsForUser` — the same source the `/projects` page uses
 * — so the cube and the legacy table list see the SAME row set when both
 * are mounted side-by-side.
 */
async function getVisibleProjectIds(ctx: SecurityContext): Promise<readonly string[]> {
  if (!ctx.userId || !ctx.organizationId) return [];
  const teams = await readTeamsForUser(ctx.userId, ctx.organizationId);
  const teamIds = teams.map((t) => t.id);
  const session = await getAuthSession();
  const orgRole = session ? await resolveOrgRoleForSession(session) : null;
  const grants = await readProjectGrantsForUser(
    ctx.userId,
    ctx.organizationId,
    {
      teamIds,
      ...(orgRole ? { orgRole } : {}),
    },
  );
  return grants.map((g) => g.projectId);
}

/**
 * Compute the actor's visible team IDs. Direct memberships come from
 * `readTeamsForUser` — the same source the `/teams` page consults.
 * `org_admin` / `org_owner` actors (resolved via the stable
 * `resolveOrgRoleForUser` contract, keyed on the SecurityContext's own
 * `(organizationId, userId)` so the resolver honors the ctx instead of
 * re-deriving identity from the cookie session) are widened to every team
 * in the active org via `listTeamsForOrg`. Non-privileged actors keep the
 * fail-closed direct-membership default; widening-path failures degrade to
 * direct membership (see `team-visibility.ts` for the policy).
 */
async function getVisibleTeamIds(ctx: SecurityContext): Promise<readonly string[]> {
  return resolveVisibleTeamIds(
    { userId: ctx.userId, organizationId: ctx.organizationId },
    {
      readTeamsForUser,
      listTeamsForOrg,
      resolveOrgRole: resolveOrgRoleForUser,
    },
  );
}

/**
 * Compute the actor's visible artifact IDs. Calls `listArtifacts` (the
 * canonical sealed-room / project_access / ownership-tier-scoped path)
 * and emits the artifact IDs. Capped to the existing 500-row ceiling
 * `listArtifacts` enforces. The cube's `id IN (...)` predicate is the
 * single source of truth for which artifacts are visible to the actor.
 */
async function getVisibleArtifactIds(ctx: SecurityContext): Promise<readonly string[]> {
  if (!ctx.userId || !ctx.organizationId) return [];
  const actor = await getActorContext();
  if (!actor) return [];
  const summaries = listArtifacts({
    orgId: ctx.organizationId,
    actor,
    limit: 500,
  });
  return summaries.map((s) => s.artifactId);
}

export const DASHBOARD_VISIBILITY_RESOLVERS: VisibilityResolvers = {
  getVisibleProjectIds,
  getVisibleTeamIds,
  getVisibleArtifactIds,
};
