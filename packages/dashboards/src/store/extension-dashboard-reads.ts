// App-side read helpers for the dashboard routes. Narrow, read-only; the
// single-writer invariant covers WRITES only, so reads here are fine. Exposed via
// a narrow subpath (NOT the auth/screens barrels) to keep the route's import graph
// light.
import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { dashboards, getDashboardsDb } from "./db";
import type { DashboardRow } from "./schema";

const ACTIVE_STATUSES = ["published"] as const;

/**
 * Rows in the actor's org that are candidates for a dashboard READ surface (the
 * `/artifacts` library's dashboard entries, the blog deep-link resolver, the
 * artifact-pointer readers): published, and EXCLUDING project-scope TEMPLATE
 * rows (`is_template = true AND template_scope = 'project'`) — those are
 * templates only; their per-project instances are the operational rows.
 * This read is NOT access-filtered: each caller applies its own gate — the
 * library hands these ids to the canonical `object.read` filter, and the blog
 * resolver only mints a detail URL whose destination re-authorizes.
 */
export async function listOrgDashboardRows(orgId: string): Promise<DashboardRow[]> {
  const db = getDashboardsDb();
  return db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, orgId),
        inArray(dashboards.status, ACTIVE_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(dashboards.createdAt));
}

/**
 * The org's boot-materialized extension dashboard TEMPLATE rows (cinatra#2474
 * PR4) — the candidate pool for the installed-catalog read. Narrow + read-only;
 * NO access check (the caller applies the liveness gate, the extension access
 * policy and the scope vantage).
 *
 * The WHERE is deliberately tight, so a malformed row never reaches the caller's
 * gates in the first place (codex convergence — `filterRenderableDashboards`
 * rejects `archived`, but on its own would let a `draft` / `generation_failed`
 * template through):
 *
 *   - `organization_id = orgId`  — tenant fence at the SQL layer;
 *   - `extension_id IS NOT NULL` — extension-owned, never an operator row;
 *   - `is_template = true`       — the template, never a materialized instance;
 *   - `status = 'published'`     — the ONE status `materializeExtensionTemplate`
 *                                  writes; anything else is not a live template.
 *
 * WHAT THIS PROVES, EXACTLY: that materialization SUCCEEDED for this package in
 * this org at some point, and that the row is still published. It does NOT
 * re-read the pack's manifest, so it cannot prove the package still ships that
 * template TODAY — and the gap is not self-healing: the boot reconcile
 * (`src/lib/dashboards/reconcile-template-materializations.ts`) UPSERTS the
 * templates it currently discovers and has NO retirement pass for one that has
 * gone away, so a package that drops its dashboard declaration leaves its
 * published row behind INDEFINITELY, across every later reconcile. Callers must
 * not claim more than this.
 */
export async function listOrgExtensionTemplateRows(
  orgId: string,
): Promise<DashboardRow[]> {
  if (!orgId) return [];
  const db = getDashboardsDb();
  return db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, orgId),
        sql`${dashboards.extensionId} IS NOT NULL`,
        eq(dashboards.isTemplate, true),
        eq(dashboards.status, "published"),
      ),
    );
}

/**
 * The dashboard NAMES already present in one `(entity, owner)` collection —
 * every status, deliberately (cinatra#2474 PR4).
 *
 * This exists because the per-entity LIST read hides archived dashboards
 * (`LISTABLE_STATUSES = draft | published`) while
 * `dashboards_entity_name_uniq` carries NO status predicate — its WHERE is only
 * `entity_type IS NOT NULL`. So an archived dashboard still OWNS its name, and a
 * caller predicting whether a create would collide must see it. Using the list
 * read would advertise a name whose create is guaranteed to fail on the
 * constraint (codex convergence r2).
 *
 * The projection is exactly the index's own key, so what this returns is
 * precisely "the names that would collide".
 *
 * NO access check — the caller gates. The one caller (`installed-catalog-read`)
 * has already proven the composite is the ACTING USER'S OWN collection in the
 * actor's own tenant, so this reads nothing the actor does not own.
 */
export async function listEntityCollectionNames(key: {
  readonly organizationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly ownerLevel: string;
  readonly ownerId: string;
}): Promise<string[]> {
  if (
    !key.organizationId ||
    !key.entityType ||
    !key.entityId ||
    !key.ownerLevel ||
    !key.ownerId
  ) {
    return [];
  }
  const db = getDashboardsDb();
  const rows = await db
    .select({ name: dashboards.name })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, key.organizationId),
        eq(dashboards.entityType, key.entityType),
        eq(dashboards.entityId, key.entityId),
        eq(dashboards.ownerLevel, key.ownerLevel),
        eq(dashboards.ownerId, key.ownerId),
      ),
    );
  return rows.map((r) => r.name);
}

/** Read a single dashboard row by id (no access check — caller gates). */
export async function readDashboardRowById(id: string): Promise<DashboardRow | undefined> {
  const db = getDashboardsDb();
  const rows = await db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
  return rows[0];
}

/**
 * Distinct org ids that hold ARCHIVED, extension-owned, contribution-keyed rows —
 * the ONLY orgs where a dashboardContribution ADOPTION could re-home an orphan
 * (cinatra#1628, S11c). The boot reconcile trigger uses this to stay DORMANT:
 * with no archived orphan rows anywhere, it reconciles zero orgs. Read-only.
 */
export async function listOrgIdsWithArchivedExtensionRows(): Promise<string[]> {
  const db = getDashboardsDb();
  const rows = await db
    .selectDistinct({ organizationId: dashboards.organizationId })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.status, "archived"),
        sql`${dashboards.extensionId} IS NOT NULL`,
        sql`${dashboards.contributionId} IS NOT NULL`,
      ),
    );
  return rows
    .map((r) => r.organizationId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** True for a project-scope TEMPLATE row, which must never render directly. */
export function isProjectTemplate(row: Pick<DashboardRow, "isTemplate" | "templateScope">): boolean {
  return row.isTemplate === true && row.templateScope === "project";
}

/** List filter: drop project-scope templates (instances + non-project templates stay). */
export function excludeProjectTemplates<T extends Pick<DashboardRow, "isTemplate" | "templateScope">>(rows: T[]): T[] {
  return rows.filter((r) => !isProjectTemplate(r));
}

// ───────────────────────────────────────────────────────────────────────────
// ALL-READER liveness/status gate (cinatra#1628, S11a — the fail-safe).
//
// After W5 (#1035) removed the workflow kind + its dashboard-archival step, an
// extension-owned dashboard row can outlive its extension: the row persists (no
// FK to installed_extension) and STILL renders + is bookmark-reachable, labelled
// with a dead package name. Archiving the rows is NOT sufficient — the by-id
// detail route reads a row with no status filter. So the fail-safe is a READER
// gate applied at EVERY read path: deny an `archived` row, and deny an
// `extension_id`-bearing row whose owning extension/contribution is not currently
// live (installed + active). Archival (the migration sweep + the committed-
// uninstall hook) is the data-hygiene COMPANION, not the safety mechanism.
//
// DECOUPLING: liveness resolution (which packages are installed+active in an org)
// lives in @cinatra-ai/extensions + the app, NOT here. This module stays a
// narrow, dependency-light read helper (it must not pull the canonical store).
// The app INJECTS an `ExtensionLivenessOracle`; these helpers are pure.
//
// FAIL-CLOSED: an unresolved oracle (a transient loader failure) must deny the
// extension row (HIDE-at-read) — never render an unverifiable orphan. The oracle
// itself never throws + never archives; a transient hide is recoverable (the row
// reappears once the oracle resolves), archival is a separate durable step.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Injected predicate: is the package `extensionId` currently LIVE (installed +
 * active/locked) for the row's organization? Built app-side from the canonical
 * install store. Must be TOTAL — return `false` (deny) rather than throw on an
 * unresolved package (fail-closed).
 */
export type ExtensionLivenessOracle = (extensionId: string) => boolean;

/** True iff the row is extension-owned (vs operator-authored). */
export function isExtensionDashboardRow(
  row: Pick<DashboardRow, "extensionId">,
): boolean {
  return row.extensionId != null;
}

/**
 * Liveness half of the gate: an operator-authored row is always live; an
 * extension-owned row is live only when the oracle confirms its package is
 * installed + active. Does NOT consider status (see {@link isDashboardRowRenderable}).
 */
export function isDashboardRowLive(
  row: Pick<DashboardRow, "extensionId">,
  isPackageLive: ExtensionLivenessOracle,
): boolean {
  if (row.extensionId == null) return true;
  return isPackageLive(row.extensionId);
}

/**
 * FULL reader gate, applied at every read surface that consults it (the
 * `/artifacts` library, the `/dashboards/{id}` + nested canonical detail routes,
 * the blog deep-link resolver, and the MCP readers) so an orphaned or archived
 * EXTENSION dashboard stops rendering everywhere — with the generic
 * empty/absent state, never a crash.
 *
 * SCOPED TO EXTENSION ROWS. An operator-authored row is NEVER hidden by this gate
 * — the caller's existing status handling governs it (the list's `published`
 * SQL filter, the by-id route's render, the MCP `status` filter), exactly as
 * before this slice. The gate exists ONLY to stop the extension-dashboard leak:
 * archiving is how the orphan sweep + the lifecycle hook retire an extension row,
 * and an archived/orphaned extension row must never render — but an operator's
 * OWN archived dashboard is their recoverable state and stays reachable exactly
 * as it was (hiding it would be a regression, not the fail-safe).
 */
export function isDashboardRowRenderable(
  row: Pick<DashboardRow, "extensionId" | "status">,
  isPackageLive: ExtensionLivenessOracle,
): boolean {
  // Operator-authored → never gated here (existing status handling wins).
  if (row.extensionId == null) return true;
  // Extension-owned → deny archived (orphan-swept / lifecycle-archived) AND deny
  // a non-live extension (orphaned). Both are the leak this closes.
  if (row.status === "archived") return false;
  return isPackageLive(row.extensionId);
}

/** List filter: keep only renderable rows (drops archived + orphaned EXTENSION
 *  rows; operator rows are governed by the caller's own status handling). */
export function filterRenderableDashboards<
  T extends Pick<DashboardRow, "extensionId" | "status">,
>(rows: T[], isPackageLive: ExtensionLivenessOracle): T[] {
  return rows.filter((r) => isDashboardRowRenderable(r, isPackageLive));
}
