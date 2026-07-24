/**
 * Scope-collection SECONDARY LISTINGS store (cinatra#1897 B4; the ratified design
 * spec at design@bb9230d9b, `specs/app-artifacts.html` §IX).
 *
 * The low-level I/O for the `dashboard_entity_links` junction plus the two reads
 * a scope's Dashboards tab needs: the dashboards HOMED in the scope (§VIII — a
 * dashboard's canonical home is its owner tier, or "project" when project-scoped;
 * `buildDashboardArtifactPointer`) and the dashboards LISTED in the scope (the
 * junction join). NO authorization lives here — the host service
 * (`src/lib/dashboards/scope-dashboards-service.ts`) layers the three-gate
 * collection-add contract (cinatra#1886) on top. Keeping this store authz-free
 * keeps the layering clean: `packages/dashboards` cannot import the host authz
 * kernel (`src/lib`), so the host composes.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import { getDashboardsDb, dashboards, dashboardEntityLinks } from "./db";
import type { ListingScopeKind } from "./schema";

// Re-export so host code (which imports this module as the flat alias
// `@cinatra-ai/dashboards/entity-links`) gets the scope-kind type + roster from
// one place, without needing a separate `store/schema` path alias.
export { LISTING_SCOPE_KINDS } from "./schema";
export type { ListingScopeKind } from "./schema";

/** A scope whose Dashboards tab lists dashboards (the three shared scopes). */
export type ListingScope = {
  readonly kind: ListingScopeKind;
  /** team id / org id / project id. */
  readonly scopeId: string;
  /** The scope's tenant — every listing + homed row is tenant-fenced to this. */
  readonly orgId: string;
};

/** One row on a scope's Dashboards tab — a homed dashboard OR a listing. The
 *  owner axis + entity anchor are carried so the host can derive the canonical
 *  href (`canonicalDashboardPath`) and, for a listed row, name its OWN home. */
export type ScopeDashboardRow = {
  readonly dashboardId: string;
  readonly name: string;
  readonly updatedAt: Date | string | null;
  readonly extensionId: string | null;
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly organizationId: string;
  /** 'home' — canonically homed here (no Remove); 'listed' — a secondary listing
   *  (carries Remove). */
  readonly relation: "home" | "listed";
};

/** The live (non-archived, non-template) dashboard columns the tab reads. */
const NOT_ARCHIVED_LIVE = (d: typeof dashboards) =>
  and(ne(d.status, "archived"), eq(d.isTemplate, false));

/**
 * The dashboards whose CANONICAL HOME is `scope` (§VIII). The home tier is the
 * owner axis (or "project" when project-scoped), mirroring
 * `buildDashboardArtifactPointer` exactly:
 *   - team         → owner_level='team'         AND owner_id=scopeId AND project_id IS NULL
 *   - organization → owner_level='organization' AND owner_id=scopeId AND project_id IS NULL
 *   - project      → project_id=scopeId
 * All tenant-fenced to `scope.orgId`. Per-user personal-for-entity dashboards
 * (owner_level='user') resolve to the "Personal" home, NOT the scope, so they are
 * correctly absent here.
 */
export async function listScopeHomedDashboards(
  scope: ListingScope,
): Promise<ScopeDashboardRow[]> {
  const db = getDashboardsDb();
  const homePredicate =
    scope.kind === "project"
      ? eq(dashboards.projectId, scope.scopeId)
      : and(
          eq(dashboards.ownerLevel, scope.kind),
          eq(dashboards.ownerId, scope.scopeId),
          isNull(dashboards.projectId),
        );
  const rows = await db
    .select({
      dashboardId: dashboards.id,
      name: dashboards.name,
      updatedAt: dashboards.updatedAt,
      extensionId: dashboards.extensionId,
      ownerLevel: dashboards.ownerLevel,
      ownerId: dashboards.ownerId,
      projectId: dashboards.projectId,
      entityType: dashboards.entityType,
      entityId: dashboards.entityId,
      organizationId: dashboards.organizationId,
    })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, scope.orgId),
        homePredicate,
        NOT_ARCHIVED_LIVE(dashboards),
      ),
    );
  return rows.map((r) => ({ ...r, relation: "home" as const }));
}

/**
 * The dashboards LISTED in `scope` (the secondary-listing junction join). Each
 * row carries the dashboard's OWN owner axis + entity anchor so the host can
 * render "home: <its canonical home>" in the meta line (§IX) and derive its
 * canonical href. Tenant-fenced by the junction's denormalized org.
 */
export async function listScopeListedDashboards(
  scope: ListingScope,
): Promise<ScopeDashboardRow[]> {
  const db = getDashboardsDb();
  const rows = await db
    .select({
      dashboardId: dashboards.id,
      name: dashboards.name,
      updatedAt: dashboards.updatedAt,
      extensionId: dashboards.extensionId,
      ownerLevel: dashboards.ownerLevel,
      ownerId: dashboards.ownerId,
      projectId: dashboards.projectId,
      entityType: dashboards.entityType,
      entityId: dashboards.entityId,
      organizationId: dashboards.organizationId,
    })
    .from(dashboardEntityLinks)
    .innerJoin(dashboards, eq(dashboards.id, dashboardEntityLinks.dashboardId))
    .where(
      and(
        eq(dashboardEntityLinks.entityType, scope.kind),
        eq(dashboardEntityLinks.entityId, scope.scopeId),
        eq(dashboardEntityLinks.organizationId, scope.orgId),
        NOT_ARCHIVED_LIVE(dashboards),
      ),
    );
  return rows.map((r) => ({ ...r, relation: "listed" as const }));
}

/** The dashboard ids already homed OR listed in `scope` — the picker's exclusion
 *  set (a candidate already present here is never re-offered). */
export async function listScopePresentDashboardIds(
  scope: ListingScope,
): Promise<Set<string>> {
  const [homed, listed] = await Promise.all([
    listScopeHomedDashboards(scope),
    listScopeListedDashboards(scope),
  ]);
  return new Set([...homed, ...listed].map((r) => r.dashboardId));
}

/**
 * Add a secondary listing. IDEMPOTENT: the UNIQUE (dashboard_id, entity_type,
 * entity_id) index makes a re-add a no-op (ON CONFLICT DO NOTHING). Returns
 * whether a NEW listing row was created (false = already listed). The caller
 * (the host service) has ALREADY authorized the add via the three-gate contract;
 * this is pure persistence.
 */
export async function addDashboardEntityLink(input: {
  dashboardId: string;
  entityType: ListingScopeKind;
  entityId: string;
  organizationId: string;
  createdBy: string;
}): Promise<{ created: boolean }> {
  const db = getDashboardsDb();
  const inserted = await db
    .insert(dashboardEntityLinks)
    .values({
      id: randomUUID(),
      dashboardId: input.dashboardId,
      entityType: input.entityType,
      entityId: input.entityId,
      organizationId: input.organizationId,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [
        dashboardEntityLinks.dashboardId,
        dashboardEntityLinks.entityType,
        dashboardEntityLinks.entityId,
      ],
    })
    .returning({ id: dashboardEntityLinks.id });
  return { created: inserted.length > 0 };
}

/**
 * Remove a secondary listing. Exact by (dashboard, scope). Returns whether a row
 * was removed (false = it was not listed). Only a LISTING is ever removed — a
 * canonical home has no junction row, so a Home row can never be unlisted here
 * (its home is its identity; §IX).
 */
export async function removeDashboardEntityLink(input: {
  dashboardId: string;
  entityType: ListingScopeKind;
  entityId: string;
  organizationId: string;
}): Promise<{ removed: boolean }> {
  const db = getDashboardsDb();
  const deleted = await db
    .delete(dashboardEntityLinks)
    .where(
      and(
        eq(dashboardEntityLinks.dashboardId, input.dashboardId),
        eq(dashboardEntityLinks.entityType, input.entityType),
        eq(dashboardEntityLinks.entityId, input.entityId),
        eq(dashboardEntityLinks.organizationId, input.organizationId),
      ),
    )
    .returning({ id: dashboardEntityLinks.id });
  return { removed: deleted.length > 0 };
}

/** Display names for a set of dashboard ids (the dashboards pool — the correct
 *  schema for the dashboards table, not the better-auth public pool). */
export async function dashboardNamesByIds(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = getDashboardsDb();
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboards)
    .where(inArray(dashboards.id, [...ids]));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/** The scopes a dashboard is LISTED in (reverse lookup — scope chips / audit). */
export async function listScopesForDashboard(
  dashboardId: string,
): Promise<{ entityType: string; entityId: string; organizationId: string }[]> {
  const db = getDashboardsDb();
  return db
    .select({
      entityType: dashboardEntityLinks.entityType,
      entityId: dashboardEntityLinks.entityId,
      organizationId: dashboardEntityLinks.organizationId,
    })
    .from(dashboardEntityLinks)
    .where(eq(dashboardEntityLinks.dashboardId, dashboardId));
}
