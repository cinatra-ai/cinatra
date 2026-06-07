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
 *     widens every cube query to the actor's visible-id lists.
 *   - Each of the four dashboard screens — calls the same
 *     resolvers so the initial render and subsequent re-queries see the
 *     same visibility surface.
 */
import "server-only";
import type { SecurityContext } from "@cinatra-ai/sdk-dashboard";

import {
  readProjectGrantsForUser,
  readTeamsForUser,
} from "@/lib/better-auth-db";
import { getActorContext, resolveOrgRoleForSession } from "@/lib/auth-session";
import { getAuthSession } from "@/lib/auth-session";
import { listArtifacts } from "@/lib/artifacts/artifact-service";

import type { VisibilityResolvers } from "./security-context";

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
 * Compute the actor's visible team IDs. Surfaces the
 * direct-membership set returned by `readTeamsForUser` — the same source
 * the `/teams` page consults. Admin-org widening is a deliberate
 * deferral: the spec mentions it as a guardrail but doesn't pin a
 * concrete query path; we surface direct membership today and add admin
 * widening once the role-resolution helper exposes a stable contract.
 */
async function getVisibleTeamIds(ctx: SecurityContext): Promise<readonly string[]> {
  if (!ctx.userId || !ctx.organizationId) return [];
  const teams = await readTeamsForUser(ctx.userId, ctx.organizationId);
  return teams.map((t) => t.id);
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
