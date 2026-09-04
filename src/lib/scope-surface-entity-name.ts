import "server-only";
/**
 * The gated per-scope NAME read behind every scoped surface's page heading
 * (cinatra#2807, per-scope surfaces S1).
 *
 * The ratified drawing makes a scope page an ENTITY page — "The page's heading
 * reads Workspace, and the page is an entity page" — and the four scoped tabs
 * are tabs OF that page, not pages of their own. So the heading keeps naming
 * the entity on every tab; the tab's own name is carried by the active tab in
 * the strip, exactly as the drawing draws it.
 *
 * Naming an entity is a disclosure, so this module repeats each scope's OWN
 * read gate before it returns a name, and returns `null` on any refusal or any
 * failure. It is the SINGLE gated read: each scope landing's gate-repeating
 * `generateMetadata` (cinatra#1737) calls it too, so the browser tab and the
 * page heading can never disagree about what the viewer may be told.
 *
 * A `null` is not an error state on the page — the header falls back to the
 * scope's kind noun ("Project", "Team", "Organization"), never to a raw or
 * title-cased id, and never to the tab's name.
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { getActorContext, getAuthSession, isPlatformAdmin, resolveOrgRoleForUser } from "@/lib/auth-session";
import { betterAuthDb, readUserIsOrgMember } from "@/lib/better-auth-db";
import { projectsDb, projects } from "@/lib/projects-store";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";
import { canManageTeamMembers } from "@/app/teams/[teamId]/settings/team-member-authority";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

/**
 * The project's name, or `null`. Gate: an authenticated caller holding a
 * resolved grant for THIS project (the sealed-room read gate, cinatra#1898).
 */
async function readProjectName(projectId: string): Promise<string | null> {
  const session = await getAuthSession();
  if (!session) return null;
  const rows = await projectsDb
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) return null;
  const actor = await getActorContext();
  if (!actor || !actorHoldsProjectGrant(actor, project.id)) return null;
  return project.name || null;
}

/**
 * The team's name, or `null`. Gate: tenant alignment (the team belongs to the
 * caller's ACTIVE organization) AND member-or-manager.
 */
async function readTeamName(teamId: string): Promise<string | null> {
  const session = await getAuthSession();
  if (!session) return null;
  const rows = await betterAuthDb.execute<{
    name: string;
    organizationId: string;
    is_member: boolean;
  }>(sql`
    SELECT
      t.name,
      t."organizationId",
      EXISTS (
        SELECT 1 FROM public."teamMember" tm
         WHERE tm."teamId" = t.id AND tm."userId" = ${session.user.id}
      ) AS is_member
    FROM public."team" t
    WHERE t.id = ${teamId}
    LIMIT 1
  `);
  const team = rows.rows?.[0];
  if (!team) return null;
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (activeOrgId !== team.organizationId) return null;
  const orgRole = await resolveOrgRoleForUser(team.organizationId, session.user.id);
  const canManage = canManageTeamMembers({
    platformAdmin: isPlatformAdmin(session),
    orgRole,
  });
  if (!team.is_member && !canManage) return null;
  return team.name || null;
}

/** The organization's name, or `null`. Gate: the caller is a member of it. */
async function readOrganizationName(id: string): Promise<string | null> {
  const session = await getAuthSession();
  const userId = session?.user.id;
  if (!userId) return null;
  if (!(await readUserIsOrgMember(userId, id))) return null;
  const rows = await betterAuthDb.execute<{ name: string | null }>(sql`
    SELECT name FROM public."organization" WHERE id = ${id} LIMIT 1
  `);
  return rows.rows?.[0]?.name || null;
}

/**
 * The entity name a scope's page header reads, or `null` when the caller may
 * not be told it or it is genuinely unavailable.
 *
 * The workspace and the personal scope are not id-bearing entities: their names
 * are fixed by the drawing itself ("The page's heading reads Workspace"), so
 * they need no read and disclose nothing.
 */
export async function readScopeSurfaceEntityName(
  scope: ScopeSurfaceRef,
): Promise<string | null> {
  try {
    switch (scope.kind) {
      case "workspace":
      case "personal":
        return null;
      case "project":
        return await readProjectName(scope.id);
      case "team":
        return await readTeamName(scope.id);
      case "organization":
        return await readOrganizationName(scope.id);
    }
  } catch {
    // A name is a convenience on this surface, never its subject: a store
    // failure must not take the page down. The header falls back to the kind.
    return null;
  }
}
