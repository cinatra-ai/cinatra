import "server-only";

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import {
  readOrgsWithTeamsForUser,
  readProjectGrantsForUser,
  readUserIsPlatformAdmin,
} from "@/lib/better-auth-db";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

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
  // admin-parity P6 (#1131). Resolve + attach `platformRole`/`orgRole` so a
  // run-derived actor keeps the SAME admin standing an interactive session
  // would carry — without this the uniform extension evaluator's kind-aware
  // admin short-circuit (#1126) is dead off the interactive session, so a
  // platform/org admin's own run loses admin standing on every downstream
  // extension check and only the installer/owner-uid match survives.
  //
  // This MIRRORS the interactive builder `buildActorContext`
  // (src/lib/authz/enforce.ts) EXACTLY so the two producers agree — that
  // parity IS the acceptance criterion (#1131): `platformRole` is the binary
  // `platform_admin | member`; `orgRole` defaults to `member` when the
  // membership resolver returns nothing (the interactive builder does
  // `opts?.orgRole ?? "member"`).
  //
  // Fail-closed on resolution error → `member` for BOTH axes: a transient DB
  // failure never fabricates `platform_admin` / `org_admin`, it floors the
  // actor at the least-privileged member tier (`readUserIsPlatformAdmin`
  // already catches internally and returns false; the try/catch here also
  // covers a throwing membership resolver).
  //
  // ACCEPTED STALENESS (documented on #1131, out of scope): delegated-run
  // snapshots and short-lived OBO tokens replay pre-change roles for their
  // lifetime, so a demoted admin keeps standing until the run ends / the
  // token expires. This resolver reads live at build time; it does not
  // re-check a captured snapshot.
  let platformRole: "platform_admin" | "member" = "member";
  let orgRole: "org_owner" | "org_admin" | "member" = "member";
  try {
    const [isPlatformAdmin, resolvedOrgRole] = await Promise.all([
      readUserIsPlatformAdmin(userId),
      resolveOrgRoleForUser(run.orgId, userId),
    ]);
    platformRole = isPlatformAdmin ? "platform_admin" : "member";
    orgRole = resolvedOrgRole ?? "member";
  } catch {
    platformRole = "member";
    orgRole = "member";
  }
  return {
    principalType: "HumanUser",
    principalId: userId,
    organizationId: run.orgId,
    teamIds,
    projectGrants,
    projectIds: projectGrants
      .map((g) => g.projectId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    platformRole,
    orgRole,
    authSource: "a2a",
    policyVersion: POLICY_VERSION,
  };
}
