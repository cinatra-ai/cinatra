/**
 * The WORKSPACE reference collection's store (cinatra#2811, per-scope surfaces
 * S5; the amended drawing, `specs/app-artifacts.html` §IX.1 and §IX.3).
 *
 * The whole-workspace scope is a reference target: a dashboard homed in any
 * scope below it can be listed on the workspace Dashboards tab as a link, never
 * a second home. A workspace link is a `dashboard_entity_links` row with
 * `entity_type='workspace'` and `entity_id='__workspace__'`, and its
 * `organization_id` is the TARGET dashboard's home organization (the listing
 * authority and the read's tenant fence both key on it).
 *
 * Authorization-free by design, exactly like `entity-links.ts`: the host
 * service decides who may read, add, remove and grant, and this module only
 * persists and reads. The audited writers that change the everyone-grant (and
 * the removal that revokes it) live in the mutation service beside the audit
 * writer; this module never writes `audit_events`.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";

import { dashboardEntityLinks, dashboards, getDashboardsDb } from "./db";
import { WORKSPACE_DASHBOARD_ENTITY_ID } from "./entity-identity";

/** One workspace reference joined to its target dashboard. */
export type WorkspaceReferenceRow = {
  readonly linkId: string;
  readonly dashboardId: string;
  readonly name: string;
  readonly updatedAt: Date | string | null;
  /** The target's home organization (the link's organization column). */
  readonly homeOrgId: string;
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly extensionId: string | null;
  readonly status: string;
  readonly isTemplate: boolean;
  readonly templateScope: string | null;
  readonly granted: boolean;
};

/** The workspace-link predicate: kind + the one '__workspace__' scope. */
const IS_WORKSPACE_LINK = and(
  eq(dashboardEntityLinks.entityType, "workspace"),
  eq(dashboardEntityLinks.entityId, WORKSPACE_DASHBOARD_ENTITY_ID),
);

/**
 * Every workspace reference, across organizations: the collection read spans
 * tenants on `entity_type='workspace'`. FENCED ON BOTH SIDES of the join, like
 * the tenant listings: the link's organization must equal the target's own, and
 * the target must be a live, non-template organization row. A malformed link
 * whose organization disagrees with its target's is never surfaced, so no name
 * crosses the fence. The host applies the VIEWER filter on top; this read is
 * never handed to a client unfiltered.
 */
export async function listWorkspaceReferenceRows(): Promise<WorkspaceReferenceRow[]> {
  const db = getDashboardsDb();
  const rows = await db
    .select({
      linkId: dashboardEntityLinks.id,
      dashboardId: dashboards.id,
      name: dashboards.name,
      updatedAt: dashboards.updatedAt,
      homeOrgId: dashboardEntityLinks.organizationId,
      ownerLevel: dashboards.ownerLevel,
      ownerId: dashboards.ownerId,
      projectId: dashboards.projectId,
      entityType: dashboards.entityType,
      entityId: dashboards.entityId,
      extensionId: dashboards.extensionId,
      status: dashboards.status,
      isTemplate: dashboards.isTemplate,
      templateScope: dashboards.templateScope,
      granted: dashboardEntityLinks.workspaceReadGranted,
    })
    .from(dashboardEntityLinks)
    .innerJoin(dashboards, eq(dashboards.id, dashboardEntityLinks.dashboardId))
    .where(
      and(
        IS_WORKSPACE_LINK,
        isNotNull(dashboards.organizationId),
        eq(dashboards.organizationId, dashboardEntityLinks.organizationId),
        ne(dashboards.status, "archived"),
        eq(dashboards.isTemplate, false),
      ),
    );
  return rows;
}

/** The dashboard ids already referenced in the workspace (the add picker's
 *  exclusion set: a referenced dashboard is never offered again). */
export async function listWorkspaceReferencedDashboardIds(): Promise<Set<string>> {
  const db = getDashboardsDb();
  const rows = await db
    .select({ dashboardId: dashboardEntityLinks.dashboardId })
    .from(dashboardEntityLinks)
    .where(IS_WORKSPACE_LINK);
  return new Set(rows.map((r) => r.dashboardId));
}

/**
 * Add a workspace reference. The link's organization is taken FROM the target
 * row itself (an INSERT ... SELECT keyed on the id AND the claimed home
 * organization), so a caller can never file a link under an organization that
 * is not the target's home, and a workspace row (org-NULL) can never be
 * referenced. IDEMPOTENT: the (dashboard, kind, scope) unique index turns a
 * re-add into a no-op. The caller has already authorized the add.
 */
export async function addWorkspaceReferenceLink(input: {
  readonly dashboardId: string;
  readonly homeOrgId: string;
  readonly createdBy: string;
}): Promise<{ created: boolean }> {
  const db = getDashboardsDb();
  const result = await db.execute(sql`
    INSERT INTO ${dashboardEntityLinks}
      (id, dashboard_id, entity_type, entity_id, organization_id, created_by)
    SELECT ${randomUUID()}, d.id, 'workspace', ${WORKSPACE_DASHBOARD_ENTITY_ID},
           d.organization_id, ${input.createdBy}
      FROM ${dashboards} d
     WHERE d.id = ${input.dashboardId}
       AND d.organization_id IS NOT NULL
       AND d.organization_id = ${input.homeOrgId}
    ON CONFLICT (dashboard_id, entity_type, entity_id) DO NOTHING
    RETURNING id
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  return { created: rows.length > 0 };
}

/** One workspace link as the curation paths read it (no join). */
export async function readWorkspaceReferenceLink(
  dashboardId: string,
): Promise<{ linkId: string; homeOrgId: string; granted: boolean } | null> {
  const db = getDashboardsDb();
  const rows = await db
    .select({
      linkId: dashboardEntityLinks.id,
      homeOrgId: dashboardEntityLinks.organizationId,
      granted: dashboardEntityLinks.workspaceReadGranted,
    })
    .from(dashboardEntityLinks)
    .where(and(IS_WORKSPACE_LINK, eq(dashboardEntityLinks.dashboardId, dashboardId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Does a STANDING everyone-grant cover this dashboard? True only while a
 * workspace link to it, filed under its own home organization, carries the
 * grant. The read-only bypass in `requireDashboardAccess` asks exactly this.
 */
export async function isWorkspaceReadGranted(
  dashboardId: string,
  homeOrgId: string,
): Promise<boolean> {
  if (!dashboardId || !homeOrgId) return false;
  const db = getDashboardsDb();
  const rows = await db
    .select({ id: dashboardEntityLinks.id })
    .from(dashboardEntityLinks)
    .where(
      and(
        IS_WORKSPACE_LINK,
        eq(dashboardEntityLinks.dashboardId, dashboardId),
        eq(dashboardEntityLinks.organizationId, homeOrgId),
        eq(dashboardEntityLinks.workspaceReadGranted, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
