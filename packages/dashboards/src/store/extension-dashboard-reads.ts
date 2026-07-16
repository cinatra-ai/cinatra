// App-side read helpers for the dashboard routes. Narrow, read-only; the
// single-writer invariant covers WRITES only, so reads here are fine. Exposed via
// a narrow subpath (NOT the auth/screens barrels) to keep the route's import graph
// light.
import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";

import { dashboards, getDashboardsDb } from "./db";
import type { DashboardRow } from "./schema";

const ACTIVE_STATUSES = ["published"] as const;

/**
 * Rows in the actor's org that are candidates for the `/dashboards` list:
 * published, and EXCLUDING project-scope TEMPLATE rows (`is_template = true AND
 * template_scope = 'project'`) — those are templates only; their per-project
 * instances are the operational rows. Owner/project access filtering is applied
 * by the caller (filterReadableDashboards).
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

/** Read a single dashboard row by id (no access check — caller gates). */
export async function readDashboardRowById(id: string): Promise<DashboardRow | undefined> {
  const db = getDashboardsDb();
  const rows = await db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
  return rows[0];
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
 * FULL reader gate, applied at every read surface (the /dashboards list + detail
 * routes, the blog deep-link resolver, and the MCP readers) so an orphaned or
 * archived EXTENSION dashboard stops rendering everywhere — with the generic
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
