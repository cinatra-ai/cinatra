import "server-only";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import {
  readOrgsWithTeamsForUser,
  readProjectGrantsForUser,
} from "@/lib/better-auth-db";

/**
 * Authoritative ActorContext builder for run-row resolution.
 *
 * Reads `run.orgId` directly rather than membership-deriving it, avoiding
 * the fallback bug class where a user's first membership could be treated
 * as the run owner organization. `run.orgId` is guaranteed non-null in
 * production; the defensive throw remains so raw-SQL test fixtures with
 * NULL surface a clear error rather than producing a broken ctx with
 * `organizationId: undefined`.
 */
export class OrgIdRequiredError extends Error {
  readonly code = "ORG_ID_REQUIRED" as const;
  constructor(runId: string) {
    super(`agent_runs.org_id is required but missing on run ${runId}`);
    this.name = "OrgIdRequiredError";
  }
}

/**
 * Narrow projection — only the fields the resolver actually needs.
 *
 * Keep the dependency slim so resolver tests can use mechanical fixtures
 * rather than broad run records.
 *
 * `orgId` mirrors the upstream NOT NULL column.
 */
export type RunForActorContext = {
  id: string;
  runBy: string | null;
  orgId: string;
};

export async function buildActorContextFromRun(
  run: RunForActorContext,
): Promise<ActorContext> {
  // Defense in depth: this branch is structurally unreachable because the
  // type says orgId is string, the column is NOT NULL, and every entry point
  // hard-fails before insert. Kept as a guard so a raw-SQL test fixture or
  // corrupt row surfaces a clear error rather than producing a broken ctx
  // with `organizationId: undefined`.
  if (!run.orgId) {
    throw new OrgIdRequiredError(run.id);
  }
  const userId = run.runBy;
  if (!userId) {
    // No human runBy (worker-originated run with no human chain). Return
    // a minimal context anchored on the run's orgId — no team/project
    // membership to resolve.
    return {
      principalType: "InternalWorker",
      principalId: `run:${run.id}`,
      organizationId: run.orgId,
      teamIds: [],
      // RESOLVED-EMPTY: a worker-originated run with no human chain has no
      // project membership. Both `projectGrants` and the derived `projectIds`
      // are `[]` (resolved, none), NOT undefined (which would mean "not
      // resolved").
      projectGrants: [],
      projectIds: [],
      authSource: "a2a",
      policyVersion: POLICY_VERSION,
    };
  }
  // Filter readOrgsWithTeamsForUser to the run's orgId, not the user's
  // first membership.
  const orgs = await readOrgsWithTeamsForUser(userId);
  const owningOrg = orgs.find((o) => o.id === run.orgId);
  const teamIds = owningOrg?.teams.map((t) => t.id) ?? [];
  // Route through the canonical resolver: owned ∪ accessed,
  // role-by-authority, active-org-anchored on run.orgId. teamRoles is
  // unavailable from public."teamMember" (no role column); missing teamRoles
  // degrades team-owned implicit grants to {read, team} — safe.
  const projectGrants = await readProjectGrantsForUser(userId, run.orgId, {
    teamIds,
  });
  return {
    principalType: "HumanUser",
    principalId: userId,
    organizationId: run.orgId,
    teamIds,
    projectGrants,
    projectIds: projectGrants
      .map((g) => g.projectId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    authSource: "a2a",
    policyVersion: POLICY_VERSION,
  };
}
