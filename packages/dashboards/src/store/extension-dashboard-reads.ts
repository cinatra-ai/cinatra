// App-side read helpers for the dashboard routes. Narrow, read-only; the
// single-writer invariant covers WRITES only, so reads here are fine. Exposed via
// a narrow subpath (NOT the auth/screens barrels) to keep the route's import graph
// light.
import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";

import { dashboards, getDashboardsDb } from "./db";
import type { DashboardRow } from "./schema";

const ACTIVE_STATUSES = ["published"] as const;

// Canonical install-lifecycle status, read directly off the `installed_extension`
// table via the dashboards DB handle.
//
// We intentionally do NOT import `@cinatra-ai/extensions`
// (`readEffectiveStatusByPackageNames`) here: declaring that workspace dep would
// close a package dependency cycle (dashboards -> extensions -> agents/workflows
// -> dashboards), which `scripts/audit/workspace-dep-cycles.mjs` forbids. This
// mirrors the established repo precedent — the marketplace readers in
// `@cinatra-ai/agents` (`readEffectiveExtensionStatusByIdentity`,
// packages/agents/src/store.ts) also read the table directly via their own DB
// handle rather than importing the extensions package — keeping the dependency
// graph one-directional. The table reference + aggregation semantics below are
// kept byte-for-byte in lockstep with the canonical source
// (`readEffectiveStatusByPackageNames` / `aggregateEffectiveStatusByPackageName`
// in packages/extensions/src/canonical-store.ts).

// Minimal drizzle reference to the canonical `installed_extension` table — only
// the two columns this read needs. Schema name resolution matches the canonical
// store (packages/extensions/src/canonical-store.ts:24).
const canonicalSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() || "cinatra");
const installedExtensionTable = canonicalSchema.table("installed_extension", {
  packageName: text("package_name").notNull(),
  status: text("status").notNull(),
});

/**
 * The PURE aggregation half of the canonical effective-status read, copied
 * verbatim from `aggregateEffectiveStatusByPackageName`
 * (packages/extensions/src/canonical-store.ts) to preserve identical
 * live-wins semantics: a `status` of "active" or "locked" is LIVE -> "active";
 * any other row contributes "archived" only if the package has no live row.
 * A package absent from the result map is treated by callers as "active"
 * (fail-safe default).
 */
export function aggregateEffectiveStatusByPackageName(
  rows: ReadonlyArray<{ packageName: string; status: string }>,
): Map<string, "active" | "archived"> {
  const result = new Map<string, "active" | "archived">();
  for (const row of rows) {
    const live = row.status === "active" || row.status === "locked";
    if (live) result.set(row.packageName, "active");
    else if (result.get(row.packageName) === undefined) result.set(row.packageName, "archived");
  }
  return result;
}

/**
 * Effective install status (active | archived) for the given package names,
 * resolved from the canonical `installed_extension` table. Mirrors
 * `readEffectiveStatusByPackageNames`
 * (packages/extensions/src/canonical-store.ts) but reads through the dashboards
 * DB handle to keep the dependency graph acyclic (see note above). An absent
 * package is simply not in the returned map (caller defaults to "active").
 */
export async function readEffectiveStatusByPackageNames(
  packageNames: string[],
): Promise<Map<string, "active" | "archived">> {
  if (packageNames.length === 0) return new Map();
  const db = getDashboardsDb();
  const rows = await db
    .select({
      packageName: installedExtensionTable.packageName,
      status: installedExtensionTable.status,
    })
    .from(installedExtensionTable)
    .where(inArray(installedExtensionTable.packageName, packageNames));
  return aggregateEffectiveStatusByPackageName(rows);
}

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
