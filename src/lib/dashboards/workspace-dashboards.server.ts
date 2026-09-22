import "server-only";
/**
 * The workspace Dashboards tab's SERVER service (cinatra#2811, per-scope
 * surfaces S5; the amended drawing, §IX.1 to §IX.4).
 *
 * The I/O adapter around the pure decisions in `workspace-dashboards-model.ts`:
 *   - the VIEWER is built from the viewer's own memberships through the epic's
 *     `WorkspaceVantage` builder (#2808), consumed as shipped, so nothing here
 *     reads the session's active organization; the tab, the curation authority
 *     and the home access therefore read the same under every one of them;
 *   - HOME ACCESS for a reference is the dashboards resolver plus the project
 *     grant (`filterReadableDashboards`), evaluated for the viewer's membership
 *     in the TARGET's home organization;
 *   - every mutation RE-AUTHORIZES on the live facts: the render gate cannot
 *     protect a later server-action call.
 */
import type { WorkspaceOverviewSummary } from "@cinatra-ai/dashboards/overview-config";
import {
  addWorkspaceReferenceLink,
  listUserWorkspaceDashboards,
  listWorkspaceReferenceRows,
  listWorkspaceReferencedDashboardIds,
  readWorkspaceReferenceLink,
  removeWorkspaceReferenceLink,
  setWorkspaceReferenceReadGrant,
} from "@cinatra-ai/dashboards/entity-links";
import {
  isDashboardRowRenderable,
  isProjectTemplate,
  listOrgDashboardRows,
  readDashboardRowById,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import {
  filterReadableDashboards,
  type DashboardActor,
  type ProjectGrantLike,
} from "@cinatra-ai/dashboards/require-dashboard-access";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectGrantsForUser,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";
import { buildWorkspaceVantage, type WorkspaceVantage } from "@/lib/scope-surface-vantage";
import {
  buildWorkspaceTabRows,
  mayCurateWorkspaceReference,
  workspaceOverviewSummaryFrom,
  type WorkspaceCurator,
  type WorkspaceTabReference,
} from "@/lib/dashboards/workspace-dashboards-model";
import type {
  AddPickerCandidateView,
  ScopeDashboardTabRow,
  ScopeListingMutation,
} from "@/components/dashboards/scope-dashboards-contract";

/** The viewer's home access in ONE member organization. */
type OrgHomeAccess = {
  readonly actor: DashboardActor;
  readonly projectGrants: readonly ProjectGrantLike[];
};

/** Everything the workspace tab decides on, read once per request. */
export type WorkspaceViewer = {
  readonly userId: string;
  readonly platformAdmin: boolean;
  readonly vantage: WorkspaceVantage;
  readonly curator: WorkspaceCurator;
  readonly homeAccess: ReadonlyMap<string, OrgHomeAccess>;
  /** Display names of the viewer's organizations, teams and projects, for the
   *  picker's "homed in" note. Only names the viewer's own reads returned. */
  readonly names: {
    readonly orgs: ReadonlyMap<string, string>;
    readonly teams: ReadonlyMap<string, string>;
    readonly projects: ReadonlyMap<string, string>;
  };
};

function isOrgManagerRole(role: string | undefined | null): boolean {
  return role === "org_owner" || role === "org_admin";
}

function toDashboardOrgRole(role: string | undefined | null): "owner" | "admin" | "member" {
  if (role === "org_owner") return "owner";
  if (role === "org_admin") return "admin";
  return "member";
}

/**
 * Build the workspace viewer from the viewer's own memberships. The session's
 * active organization is accepted and deliberately NOT read (named so the
 * omission is visible): the vantage builder ignores it, and every per-org fact
 * below is read under the organization it belongs to.
 */
export async function buildWorkspaceViewer(input: {
  readonly userId: string;
  readonly platformAdmin: boolean;
  readonly activeOrganizationId?: string | null;
}): Promise<WorkspaceViewer> {
  void input.activeOrganizationId;
  const userId = input.userId;
  const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
  const teamIdsByOrg: Record<string, string[]> = {};
  const projectIdsByOrg: Record<string, string[]> = {};
  const orgNames = new Map<string, string>();
  const teamNames = new Map<string, string>();
  const projectNames = new Map<string, string>();
  for (const org of orgs) {
    orgNames.set(org.id, org.name);
    teamIdsByOrg[org.id] = org.teams.map((t) => t.id);
    for (const t of org.teams) teamNames.set(t.id, t.name);
    const projects = await readProjectsForUser(userId, org.id);
    projectIdsByOrg[org.id] = projects.map((p) => p.id);
    for (const p of projects) projectNames.set(p.id, p.name);
  }
  const vantage = buildWorkspaceVantage({
    userId,
    memberships: orgs.map((org) => ({ orgId: org.id })),
    teamIdsByOrg,
    projectIdsByOrg,
  });

  const managedOrgIds = new Set<string>();
  const homeAccess = new Map<string, OrgHomeAccess>();
  for (const org of vantage.organizations) {
    const role = await resolveOrgRoleForUser(org.orgId, userId);
    if (isOrgManagerRole(role)) managedOrgIds.add(org.orgId);
    const teamIds = [...org.teamIds];
    const orgRole = role ?? "member";
    const grants = await readProjectGrantsForUser(userId, org.orgId, {
      teamIds,
      orgRole: orgRole as "org_owner" | "org_admin" | "member",
    });
    homeAccess.set(org.orgId, {
      actor: {
        userId,
        organizationId: org.orgId,
        teamIds,
        orgRole: toDashboardOrgRole(role),
        teamRoles: {},
      },
      projectGrants: grants.map((g) => ({ projectId: g.projectId, effectiveRole: g.effectiveRole })),
    });
  }

  return {
    userId,
    platformAdmin: input.platformAdmin,
    vantage,
    curator: { platformAdmin: input.platformAdmin, managedOrgIds },
    homeAccess,
    names: { orgs: orgNames, teams: teamNames, projects: projectNames },
  };
}

/** The dashboard fields home access reads (a row or a reference). */
type HomeAccessRow = {
  readonly organizationId: string | null;
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
};

/**
 * Does the viewer pass the target's HOME access? The dashboards resolver plus
 * the project grant, for the viewer's membership in the target's own home
 * organization. No membership there means no home access (fail-closed).
 */
export function viewerPassesHomeAccess(viewer: WorkspaceViewer, row: HomeAccessRow): boolean {
  if (!row.organizationId) return false;
  const access = viewer.homeAccess.get(row.organizationId);
  if (!access) return false;
  return filterReadableDashboards([row as never], access.actor, access.projectGrants).length === 1;
}

/**
 * The workspace tab's rows: the viewer's own workspace dashboards (Overview
 * first) and the references the viewer filter admits. The Overview itself is
 * ensured by the page (a write) before this read.
 */
export async function getWorkspaceDashboardsRows(
  viewer: WorkspaceViewer,
): Promise<ScopeDashboardTabRow[]> {
  const [own, references] = await Promise.all([
    listUserWorkspaceDashboards(viewer.userId),
    listWorkspaceReferenceRows(),
  ]);
  const liveness = new Map<string, (extensionId: string) => boolean>();
  const referenceFacts: WorkspaceTabReference[] = [];
  for (const r of references) {
    let isLive = liveness.get(r.homeOrgId);
    if (!isLive) {
      isLive = await resolveLiveExtensionPredicate(r.homeOrgId);
      liveness.set(r.homeOrgId, isLive);
    }
    // An orphaned or archived extension dashboard is not an operational
    // surface anywhere, so it is not listed here either.
    if (!isDashboardRowRenderable(r, isLive)) continue;
    referenceFacts.push({
      dashboardId: r.dashboardId,
      name: r.name,
      updatedAt: r.updatedAt,
      homeOrgId: r.homeOrgId,
      entityType: r.entityType,
      entityId: r.entityId,
      granted: r.granted,
      passesHomeAccess: viewerPassesHomeAccess(viewer, { ...r, organizationId: r.homeOrgId }),
    });
  }
  return buildWorkspaceTabRows({ own, references: referenceFacts, curator: viewer.curator });
}

/** Does the viewer curate anything at all (does any Remove or Add apply)? */
export function viewerCuratesAnyReference(viewer: WorkspaceViewer): boolean {
  return viewer.curator.platformAdmin || viewer.curator.managedOrgIds.size > 0;
}

function homeNoteFor(viewer: WorkspaceViewer, row: HomeAccessRow): string {
  if (row.projectId) {
    const name = viewer.names.projects.get(row.projectId);
    return name ? `homed in Project: ${name}` : "homed in a project";
  }
  switch (row.ownerLevel) {
    case "team": {
      const name = viewer.names.teams.get(row.ownerId);
      return name ? `homed in Team: ${name}` : "homed in a team";
    }
    case "organization": {
      const name = viewer.names.orgs.get(row.ownerId);
      return name ? `homed in Organization: ${name}` : "homed in an organization";
    }
    case "user":
      return "homed in Personal";
    default:
      return "homed in a scope below";
  }
}

/**
 * The reference picker's pool (§IX.1, §IX.3): the dashboards the viewer can
 * see, homed in the organizations the viewer curates, minus templates and
 * anything already referenced. The workspace has no promotion recourse, so
 * every candidate is directly addable. A dashboard the viewer cannot see never
 * appears, so the picker names nothing the viewer could not already open.
 */
export async function listWorkspaceReferenceCandidates(
  viewer: WorkspaceViewer,
): Promise<AddPickerCandidateView[]> {
  const present = await listWorkspaceReferencedDashboardIds();
  const out: AddPickerCandidateView[] = [];
  for (const org of viewer.vantage.organizations) {
    if (!mayCurateWorkspaceReference(viewer.curator, org.orgId)) continue;
    const [rows, isLive] = await Promise.all([
      listOrgDashboardRows(org.orgId),
      resolveLiveExtensionPredicate(org.orgId),
    ]);
    for (const row of rows) {
      if (present.has(row.id)) continue;
      // A default Overview is a per-user shell default, never a target.
      if (row.isDefault) continue;
      if (row.isTemplate || isProjectTemplate(row)) continue;
      if (!isDashboardRowRenderable(row, isLive)) continue;
      if (!viewerPassesHomeAccess(viewer, row)) continue;
      out.push({
        dashboardId: row.id,
        name: row.name,
        homeNote: homeNoteFor(viewer, row),
        disposition: "addable",
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }));
  return out;
}

/**
 * Reference a dashboard in the workspace. RE-AUTHORIZED on the live row: it
 * must be a live, non-template organization dashboard (never a workspace row,
 * never a default Overview),
 * the viewer must pass its home access, and the viewer must curate its home
 * organization. The link is filed under the target's own organization.
 */
export async function addWorkspaceReference(
  viewer: WorkspaceViewer,
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const row = await readDashboardRowById(dashboardId);
  if (!row) return { ok: false, reason: "not-found" };
  if (!row.organizationId || row.isDefault || row.isTemplate || isProjectTemplate(row)) {
    return { ok: false, reason: "invalid" };
  }
  if (!mayCurateWorkspaceReference(viewer.curator, row.organizationId)) {
    return { ok: false, reason: "denied" };
  }
  if (!viewerPassesHomeAccess(viewer, row)) return { ok: false, reason: "denied" };
  const isLive = await resolveLiveExtensionPredicate(row.organizationId);
  if (!isDashboardRowRenderable(row, isLive)) return { ok: false, reason: "invalid" };
  await addWorkspaceReferenceLink({
    dashboardId,
    homeOrgId: row.organizationId,
    createdBy: viewer.userId,
  });
  return { ok: true };
}

/** Remove a workspace reference: curation of the LINK's home organization
 *  (platform administrators: any link). A granted link's removal records the
 *  revocation (the store writes it). */
export async function removeWorkspaceReference(
  viewer: WorkspaceViewer,
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const link = await readWorkspaceReferenceLink(dashboardId);
  if (!link) return { ok: false, reason: "not-found" };
  if (!mayCurateWorkspaceReference(viewer.curator, link.homeOrgId)) {
    return { ok: false, reason: "denied" };
  }
  await removeWorkspaceReferenceLink({ dashboardId, homeOrgId: link.homeOrgId }, viewer.userId);
  return { ok: true };
}

/** Set or clear the everyone-grant: a platform administrator's alone (§IX.4). */
export async function setWorkspaceEveryoneGrant(
  viewer: WorkspaceViewer,
  dashboardId: string,
  granted: boolean,
): Promise<ScopeListingMutation> {
  if (!viewer.platformAdmin) return { ok: false, reason: "denied" };
  const link = await readWorkspaceReferenceLink(dashboardId);
  if (!link) return { ok: false, reason: "not-found" };
  const result = await setWorkspaceReferenceReadGrant(
    { dashboardId, homeOrgId: link.homeOrgId, granted },
    viewer.userId,
  );
  if (result.missing) return { ok: false, reason: "not-found" };
  return { ok: true };
}

/** The workspace Overview's summary: the instance's display name and
 *  namespace (the identity row's non-secret fields only) and the viewer's
 *  vantage counts. */
export async function readWorkspaceOverviewSummary(
  viewer: WorkspaceViewer,
): Promise<WorkspaceOverviewSummary> {
  let identity: { instanceDisplayName?: string | null; instanceNamespace?: string | null } | null = null;
  try {
    const row = readInstanceIdentity();
    identity = row
      ? { instanceDisplayName: row.instanceDisplayName, instanceNamespace: row.instanceNamespace }
      : null;
  } catch {
    // An unreadable identity row reads as none: the Overview names the scope.
    identity = null;
  }
  return workspaceOverviewSummaryFrom(identity, viewer.vantage);
}
