// App-side dashboard access adapter. Thin wrapper over the dashboards-package
// resolver: maps a resolved actor (carrying `projectGrants`) into the package's
// owner-gate inputs + the already-resolved project grants, then delegates.
//
// `requireDashboardAccess` is the live product gate — the `/dashboards/{id}` +
// nested canonical detail routes and the artifact-pointer readers go through it.
//
// `filterReadableDashboards` no longer has a product caller: the workspace-wide
// `/dashboards` directory list that used it was retired in cinatra#2058. It is
// KEPT DELIBERATELY (reviewed in cinatra#2474 item 6) as the conformance seam of
// the #1898/#1988 ACL invariants: it is the only callable that composes what
// production composes — the private `toDashboardActor` role normalization
// (`org_owner`/`org_admin`/`team_admin` → the package vocabulary), the package
// owner gate, and the resolved project grants. Deleting it would force those
// proofs to hand-roll a copy of that normalization, which could drift from this
// file and let the agreement pass against a mapping production no longer does.
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
// (see resolveOrgRoleForSession). Normalize so route wiring with the real
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

/** Filter dashboard rows to those the actor may READ (owner gate + project
 *  grant). No product caller — the #1898/#1988 conformance seam; see the header. */
export function filterReadableDashboards<T extends { projectId: string | null }>(
  rows: T[],
  actor: DashboardAuthzActor,
): T[] {
  return pkgFilterReadableDashboards(rows, toDashboardActor(actor), actor.projectGrants ?? []);
}
