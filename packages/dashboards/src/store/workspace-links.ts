/**
 * The WORKSPACE reference collection's store (cinatra#2811, per-scope surfaces
 * S5; the amended drawing, §IX.1 and §IX.3).
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
 * persists, reads and records. The everyone-grant's two writers (set or clear
 * it, and remove a link, which revokes a standing grant) write their audit row
 * in the same transaction as the link change.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import {
  auditEvents,
  dashboardEntityLinks,
  dashboards,
  getDashboardsDb,
  type DashboardsDb,
} from "./db";
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
 * referenced. A default Overview is never a target either: it is a per-user
 * shell default, not a shareable dashboard, and organization deletion removes
 * those rows directly (without the delete writer that records a revocation).
 * IDEMPOTENT: the (dashboard, kind, scope) unique index turns a re-add into a
 * no-op. The caller has already authorized the add.
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
       AND d.is_default = false
    ON CONFLICT (dashboard_id, entity_type, entity_id) DO NOTHING
    RETURNING id
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  return { created: rows.length > 0 };
}

/**
 * The acting user's OWN workspace dashboards (org-NULL, the user-owned
 * '__workspace__' entity), live ones only, with the fields the tab rows read.
 * Authorization-free: the caller passes the SESSION user, and a user's own
 * workspace rows are theirs by the owner axis itself; the query names that
 * owner, so no other user's row can appear.
 */
export async function listUserWorkspaceDashboards(userId: string): Promise<
  Array<{
    readonly dashboardId: string;
    readonly name: string;
    readonly updatedAt: Date | string | null;
    readonly isDefault: boolean;
  }>
> {
  if (!userId) return [];
  const db = getDashboardsDb();
  return db
    .select({
      dashboardId: dashboards.id,
      name: dashboards.name,
      updatedAt: dashboards.updatedAt,
      isDefault: dashboards.isDefault,
    })
    .from(dashboards)
    .where(
      and(
        isNull(dashboards.organizationId),
        eq(dashboards.entityType, "workspace"),
        eq(dashboards.entityId, WORKSPACE_DASHBOARD_ENTITY_ID),
        eq(dashboards.ownerLevel, "user"),
        eq(dashboards.ownerId, userId),
        ne(dashboards.status, "archived"),
      ),
    );
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

// ─────────────────────────────────────────────────────────────────────────
// The everyone-grant's audited writers (cinatra#2811; the amended drawing
// §IX.4). A platform administrator may mark a workspace
// reference "visible to everyone": a READ-ONLY grant on the link row, never on
// the dashboard's home access. Setting it, clearing it and removing a granted
// link are each recorded as an append-only `audit_events` row in the SAME
// transaction as the link change, naming the actor, the link, the dashboard,
// the prior state and the moment. Clearing the live grant never touches its
// audit history. AUTHORIZATION IS THE CALLER'S: the host service decides who
// may grant (a platform administrator alone) and who may remove (the link's
// curators); these writers only persist and record.
//
// WHY HERE and not in the mutation service: they write the LINKS table, like
// the listing writers of `entity-links.ts`, never `dashboards`; and the audit
// row must commit in the same transaction as the link change. This module is
// the one other sanctioned writer of `audit_events` through the dashboards
// store (see `audit-events-schema.ts`), and only for these two events.
// ─────────────────────────────────────────────────────────────────────────

/** The two audit operations the everyone-grant writes. */
export const WORKSPACE_READ_GRANTED_OPERATION = "dashboard.workspace_read_granted";
export const WORKSPACE_READ_REVOKED_OPERATION = "dashboard.workspace_read_revoked";

type WorkspaceLinkForUpdate = {
  readonly id: string;
  readonly organizationId: string;
  readonly granted: boolean;
  readonly grantedBy: string | null;
  readonly grantedAt: Date | null;
};

/** Lock the one workspace link to `dashboardId` filed under `homeOrgId`. */
async function selectWorkspaceLinkForUpdate(
  tx: DashboardsDb,
  dashboardId: string,
  homeOrgId: string,
): Promise<WorkspaceLinkForUpdate | undefined> {
  const rows = await tx
    .select({
      id: dashboardEntityLinks.id,
      organizationId: dashboardEntityLinks.organizationId,
      granted: dashboardEntityLinks.workspaceReadGranted,
      grantedBy: dashboardEntityLinks.workspaceReadGrantedBy,
      grantedAt: dashboardEntityLinks.workspaceReadGrantedAt,
    })
    .from(dashboardEntityLinks)
    .where(
      and(
        eq(dashboardEntityLinks.dashboardId, dashboardId),
        eq(dashboardEntityLinks.entityType, "workspace"),
        eq(dashboardEntityLinks.entityId, WORKSPACE_DASHBOARD_ENTITY_ID),
        eq(dashboardEntityLinks.organizationId, homeOrgId),
      ),
    )
    .for("update")
    .limit(1);
  return rows[0];
}

/** Record one everyone-grant change (append-only; same transaction). */
async function writeWorkspaceGrantAudit(
  tx: DashboardsDb,
  input: {
    readonly operation: typeof WORKSPACE_READ_GRANTED_OPERATION | typeof WORKSPACE_READ_REVOKED_OPERATION;
    readonly actorUserId: string;
    readonly dashboardId: string;
    readonly link: WorkspaceLinkForUpdate;
    readonly at: Date;
    readonly reason: "set" | "unset" | "reference-removed";
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    organizationId: input.link.organizationId,
    actorPrincipalId: input.actorUserId,
    actorPrincipalType: "user",
    resourceType: "dashboard",
    resourceId: input.dashboardId,
    operation: input.operation,
    decision: "allow",
    metadata: {
      linkId: input.link.id,
      dashboardId: input.dashboardId,
      actor: input.actorUserId,
      reason: input.reason,
      prior: {
        granted: input.link.granted,
        grantedBy: input.link.grantedBy,
        grantedAt: input.link.grantedAt ? input.link.grantedAt.toISOString() : null,
      },
      at: input.at.toISOString(),
    },
  });
}

/**
 * Set or clear the everyone-grant on the workspace link to `dashboardId`
 * (filed under its home organization). A no-op when the link already holds the
 * requested state (nothing changes, so nothing is recorded). `missing` when no
 * such link exists: the grant rides a link, never a dashboard.
 */
export async function setWorkspaceReferenceReadGrant(
  input: { readonly dashboardId: string; readonly homeOrgId: string; readonly granted: boolean },
  actorUserId: string,
): Promise<{ changed: boolean; missing?: true }> {
  if (!actorUserId) throw new Error("workspace everyone-grant: an acting user is required");
  return getDashboardsDb().transaction(async (t) => {
    const tx = t as unknown as DashboardsDb;
    const link = await selectWorkspaceLinkForUpdate(tx, input.dashboardId, input.homeOrgId);
    if (!link) return { changed: false, missing: true as const };
    if (link.granted === input.granted) return { changed: false };
    const at = new Date();
    await tx
      .update(dashboardEntityLinks)
      .set(
        input.granted
          ? { workspaceReadGranted: true, workspaceReadGrantedBy: actorUserId, workspaceReadGrantedAt: at }
          : { workspaceReadGranted: false, workspaceReadGrantedBy: null, workspaceReadGrantedAt: null },
      )
      .where(eq(dashboardEntityLinks.id, link.id));
    await writeWorkspaceGrantAudit(tx, {
      operation: input.granted ? WORKSPACE_READ_GRANTED_OPERATION : WORKSPACE_READ_REVOKED_OPERATION,
      actorUserId,
      dashboardId: input.dashboardId,
      link,
      at,
      reason: input.granted ? "set" : "unset",
    });
    return { changed: true };
  });
}

/**
 * Remove the workspace link to `dashboardId` (filed under its home
 * organization). Removing a GRANTED link revokes the grant, so the revocation
 * is recorded in the same transaction before the row goes; an ungranted link
 * leaves no grant record to write.
 */
export async function removeWorkspaceReferenceLink(
  input: { readonly dashboardId: string; readonly homeOrgId: string },
  actorUserId: string,
): Promise<{ removed: boolean }> {
  if (!actorUserId) throw new Error("workspace reference removal: an acting user is required");
  return getDashboardsDb().transaction(async (t) => {
    const tx = t as unknown as DashboardsDb;
    const link = await selectWorkspaceLinkForUpdate(tx, input.dashboardId, input.homeOrgId);
    if (!link) return { removed: false };
    if (link.granted) {
      await writeWorkspaceGrantAudit(tx, {
        operation: WORKSPACE_READ_REVOKED_OPERATION,
        actorUserId,
        dashboardId: input.dashboardId,
        link,
        at: new Date(),
        reason: "reference-removed",
      });
    }
    await tx.delete(dashboardEntityLinks).where(eq(dashboardEntityLinks.id, link.id));
    return { removed: true };
  });
}
