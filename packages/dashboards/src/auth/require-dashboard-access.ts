// Dashboard access resolver. Layers a PROJECT-scope gate on top
// of the existing 4-tier owner resolver. A dashboard with project_id != NULL must
// pass BOTH gates; project_id NULL applies only the owner gate (unchanged behavior).
//
// The DB read + the two gates live here (the dashboards db is server-side); the
// app-side `src/lib/dashboards/authz.ts` wrapper adapts a PrimitiveActorContext
// (extracting projectGrants) and delegates here, so the resolver consumes ALREADY-
// resolved project grants rather than calling a project_access primitive per row.
import "server-only";
import { eq } from "drizzle-orm";

import { dashboards, getDashboardsDb } from "../store/db";
import { resolveDashboardAccess, type DashboardActor } from "../permissions";

export type { DashboardActor } from "../permissions";

export type DashboardAccessMode = "read" | "write" | "admin";

/** Effective project role rank — owner > admin > write > read (mirrors the app
 *  project-writable ranking; duplicated here to avoid a package→app import). */
const PROJECT_ROLE_RANK: Record<string, number> = { read: 0, write: 1, admin: 2, owner: 3 };
const REQUIRED_RANK: Record<DashboardAccessMode, number> = { read: 0, write: 1, admin: 2 };

export type ProjectGrantLike = { projectId: string; effectiveRole: "read" | "write" | "admin" | "owner" };

export class DashboardAccessError extends Error {
  readonly code: "dashboard_not_found" | "dashboard_forbidden";
  readonly httpStatus: number;
  constructor(code: "dashboard_not_found" | "dashboard_forbidden", message: string) {
    super(message);
    this.code = code;
    this.httpStatus = code === "dashboard_not_found" ? 404 : 403;
    this.name = "DashboardAccessError";
  }
}

export type DashboardAuthzInput = {
  actor: DashboardActor;
  projectGrants: readonly ProjectGrantLike[];
  dashboardId: string;
  mode: DashboardAccessMode;
};

/**
 * Throws DashboardAccessError on deny. Step 1 = owner-level gate (existing 4-tier
 * resolver). Step 2 (only when project_id != NULL) = project-grant rank vs mode.
 * Returns the dashboard row on success.
 */
export async function requireDashboardAccess(input: DashboardAuthzInput) {
  const db = getDashboardsDb();
  const rows = await db.select().from(dashboards).where(eq(dashboards.id, input.dashboardId)).limit(1);
  const row = rows[0];
  if (!row) throw new DashboardAccessError("dashboard_not_found", `Dashboard not found: ${input.dashboardId}`);

  // Step 1 — owner-level gate (unchanged).
  const access = resolveDashboardAccess(row, input.actor);
  const ownerOk = input.mode === "read" ? access.canRead : access.canWrite;
  if (!ownerOk) {
    throw new DashboardAccessError("dashboard_forbidden", `Access denied for dashboard ${input.dashboardId}`);
  }

  // Step 2 — project-grant gate (only for project-scoped dashboards).
  if (row.projectId) {
    const grant = input.projectGrants.find((g) => g.projectId === row.projectId);
    const rank = grant ? (PROJECT_ROLE_RANK[grant.effectiveRole] ?? -1) : -1;
    if (rank < REQUIRED_RANK[input.mode]) {
      throw new DashboardAccessError("dashboard_forbidden", `No ${input.mode} grant on project ${row.projectId} for dashboard ${input.dashboardId}`);
    }
  }

  return row;
}

/** Filter a list of dashboard rows to those the actor may READ (owner gate +,
 *  for project-scoped rows, a project grant). Pure — no DB read. */
export function filterReadableDashboards<T extends { projectId: string | null }>(
  rows: T[],
  actor: DashboardActor,
  projectGrants: readonly ProjectGrantLike[],
): T[] {
  const grantedProjects = new Set(projectGrants.map((g) => g.projectId));
  return rows.filter((row) => {
    const access = resolveDashboardAccess(row as never, actor);
    if (!access.canRead) return false;
    if (row.projectId) return grantedProjects.has(row.projectId);
    return true;
  });
}
