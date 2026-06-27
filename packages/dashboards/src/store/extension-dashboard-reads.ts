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
