import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { projectCoOwners, projects, projectsDb } from "@/lib/projects-store";

// ---------------------------------------------------------------------------
// project_co_owners DAO.
// Mirrors packages/agent-builder/src/store.ts run_co_owners helpers verbatim.
// addProjectCoOwner uses ON CONFLICT DO NOTHING for atomic idempotency
// (the composite PK enforces uniqueness; double-add is a no-op rather than an
// error).
// ---------------------------------------------------------------------------

export type ProjectCoOwner = {
  projectId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export async function readProjectCoOwners(projectId: string): Promise<ProjectCoOwner[]> {
  const rows = await projectsDb
    .select()
    .from(projectCoOwners)
    .where(eq(projectCoOwners.projectId, projectId))
    .orderBy(asc(projectCoOwners.grantedAt));
  return rows.map((r) => ({
    projectId: r.projectId,
    userId:    r.userId,
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
  }));
}

export async function addProjectCoOwner(
  projectId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  await projectsDb
    .insert(projectCoOwners)
    .values({ projectId, userId, grantedBy })
    .onConflictDoNothing();
}

/**
 * Remove a co-owner row. Returns the number of rows deleted (0 if absent, 1
 * on success).
 */
export async function removeProjectCoOwner(
  projectId: string,
  userId: string,
): Promise<number> {
  const result = await projectsDb
    .delete(projectCoOwners)
    .where(and(eq(projectCoOwners.projectId, projectId), eq(projectCoOwners.userId, userId)));
  // node-postgres drizzle returns { rowCount } on the underlying result; the
  // typed wrapper exposes it via `.rowCount`. Fall back to 0 when unavailable.
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Last-owner guard. Returns true when the supplied userId is the current
 * projects.owner_id AND there are no co-owners — i.e. removing them would
 * leave the project orphaned. Server actions must reject the operation in
 * that case.
 */
export async function isLastOwner(projectId: string, userId: string): Promise<boolean> {
  const ownerRow = await projectsDb
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (ownerRow.length === 0) return false;
  if (ownerRow[0].ownerId !== userId) return false;
  const coOwnerCount = await projectsDb
    .select({ count: sql<number>`count(*)::int` })
    .from(projectCoOwners)
    .where(eq(projectCoOwners.projectId, projectId));
  return (coOwnerCount[0]?.count ?? 0) === 0;
}
