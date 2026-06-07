// App-side dashboard access resolver. Thin adapter over the dashboards-package
// resolver: maps a resolved actor (carrying `projectGrants`) into the package's
// owner-gate inputs + the already-resolved project grants, then delegates.
// Wire this into the dashboards read paths (dashboards_get / dashboards_list /
// the /dashboards routes).
import "server-only";

// Narrow subpath (NOT the `@cinatra-ai/dashboards/auth` barrel, which transitively
// pulls in @cinatra-ai/agents via the security-context / visibility resolvers).
import {
  requireDashboardAccess as pkgRequireDashboardAccess,
  filterReadableDashboards as pkgFilterReadableDashboards,
  DashboardAccessError,
  type DashboardAccessMode,
  type ProjectGrantLike,
  type DashboardActor,
} from "@cinatra-ai/dashboards/require-dashboard-access";

export { DashboardAccessError, type DashboardAccessMode };

// Structural actor shape (a resolved PrimitiveActorContext / role-hinted actor).
// Kept structural to avoid coupling to a single import while accepting the live
// resolved-actor objects the routes + MCP handlers already build.
export type DashboardAuthzActor = {
  userId: string;
  orgId?: string | null;
  organizationId?: string | null;
  teamIds?: readonly string[];
  // Accept BOTH the dashboard-local enum and the resolved kernel enum
  // (`org_owner`/`org_admin`/`member`, `team_admin`) — normalized below.
  orgRole?: string | null;
  teamRoles?: Readonly<Record<string, string>>;
  projectGrants?: readonly ProjectGrantLike[];
};

// The dashboards owner resolver only recognizes owner/admin/member (org) +
// admin/member (team). Resolved app actors use org_owner/org_admin + team_admin
// (see resolveOrgRoleForSession). Normalize so DASH-05 route wiring with the real
// resolved actor doesn't deny org admins/owners.
function normalizeOrgRole(role: string | null | undefined): "owner" | "admin" | "member" {
  if (role === "owner" || role === "org_owner") return "owner";
  if (role === "admin" || role === "org_admin") return "admin";
  return "member";
}
function normalizeTeamRoles(roles: Readonly<Record<string, string>> | undefined): Record<string, "admin" | "member"> {
  const out: Record<string, "admin" | "member"> = {};
  for (const [teamId, role] of Object.entries(roles ?? {})) {
    out[teamId] = role === "admin" || role === "team_admin" ? "admin" : "member";
  }
  return out;
}

function toDashboardActor(actor: DashboardAuthzActor): DashboardActor {
  return {
    userId: actor.userId,
    organizationId: (actor.organizationId ?? actor.orgId) as string,
    teamIds: actor.teamIds ?? [],
    orgRole: normalizeOrgRole(actor.orgRole),
    teamRoles: normalizeTeamRoles(actor.teamRoles),
  };
}

/** Throws DashboardAccessError (404 not-found / 403 forbidden) on deny. */
export async function requireDashboardAccess(
  actor: DashboardAuthzActor,
  dashboardId: string,
  mode: DashboardAccessMode,
) {
  return pkgRequireDashboardAccess({
    actor: toDashboardActor(actor),
    projectGrants: actor.projectGrants ?? [],
    dashboardId,
    mode,
  });
}

/** Filter dashboard rows to those the actor may READ (owner gate + project grant). */
export function filterReadableDashboards<T extends { projectId: string | null }>(
  rows: T[],
  actor: DashboardAuthzActor,
): T[] {
  return pkgFilterReadableDashboards(rows, toDashboardActor(actor), actor.projectGrants ?? []);
}
