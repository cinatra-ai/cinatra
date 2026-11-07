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
 * read gate before it returns a name. It answers in three states
 * (`ScopeSurfaceEntityName`, cinatra#4453): `named`, `blank` for a reader who
 * may read the entity whose name is genuinely unavailable, and `unavailable`
 * for a refusal, a missing entity or any failure before the access decision.
 * It is the SINGLE gated read: each scope landing's gate-repeating
 * `generateMetadata` (cinatra#1737) calls it too, so the browser tab and the
 * page heading can never disagree about what the viewer may be told.
 *
 * EACH GATE READS THE ENTITY'S OWN TENANT (cinatra#3787). The team gate no longer
 * requires "tenant alignment", which meant the team belonging to the session's
 * ACTIVE organization. A team surface belongs to the TEAM's organization, whatever the
 * session has active (the owner's decision on cinatra#3693), and the project gate
 * never compared the active organization in the first place.
 *
 * An answer that is not `named` is not an error state on the page — the header
 * falls back to the scope's kind noun ("Project", "Team", "Organization"), never
 * to a raw or title-cased id, and never to the tab's name. The crumb draws what
 * the drawing draws for each answer (`scopeSurfaceEntityLabel`).
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { getActorContext, getAuthSession, isPlatformAdmin, resolveOrgRoleForUser } from "@/lib/auth-session";
import { betterAuthDb, readUserIsOrgMember } from "@/lib/better-auth-db";
import { projectsDb, projects } from "@/lib/projects-store";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";
import { resolveTeamSurfaceAccess } from "@/lib/team-surface-access";
import type { ScopeSurfaceEntityName, ScopeSurfaceRef } from "@/lib/scope-surfaces";

const UNAVAILABLE: ScopeSurfaceEntityName = { state: "unavailable" };

/** The answer for a reader the gate allowed: the name, or `blank` (cinatra#4453). */
function allowedName(name: string | null | undefined): ScopeSurfaceEntityName {
  const trimmed = name?.trim();
  return trimmed ? { state: "named", name: trimmed } : { state: "blank" };
}

/**
 * The project's name. Gate: an authenticated caller holding a
 * resolved grant for THIS project (the sealed-room read gate, cinatra#1898).
 */
async function readProjectName(projectId: string): Promise<ScopeSurfaceEntityName> {
  const session = await getAuthSession();
  if (!session) return UNAVAILABLE;
  const rows = await projectsDb
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) return UNAVAILABLE;
  const actor = await getActorContext();
  if (!actor || !actorHoldsProjectGrant(actor, project.id)) return UNAVAILABLE;
  return allowedName(project.name);
}

/**
 * The team's name. Gate: membership or management of the team,
 * resolved against the TEAM's own organization (cinatra#3787).
 *
 * The gate used to require tenant alignment first: the team had to belong to the
 * caller's ACTIVE organization, and it returned `null` whenever it did not. That
 * left a reader who may open the team's surfaces with a raw identifier in the
 * trail and the bare word "Team" as the heading, the platform admin among them.
 * The tenant of a team surface is the team's organization, so the name follows
 * the same rule the landing and the team's dashboard actions now follow.
 */
async function readTeamName(teamId: string): Promise<ScopeSurfaceEntityName> {
  const session = await getAuthSession();
  if (!session) return UNAVAILABLE;
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
  if (!team) return UNAVAILABLE;
  const orgRole = await resolveOrgRoleForUser(team.organizationId, session.user.id);
  const access = resolveTeamSurfaceAccess({
    team,
    isMember: team.is_member,
    platformAdmin: isPlatformAdmin(session),
    orgRole,
  });
  if (access.outcome !== "allowed") return UNAVAILABLE;
  return allowedName(team.name);
}

/**
 * The organization's name. Gate: the caller is a member of it. The name is read
 * after the membership decision, so a failure of that one read answers `blank`
 * to a member: the name is genuinely unavailable to a reader who may read it.
 */
async function readOrganizationName(id: string): Promise<ScopeSurfaceEntityName> {
  const session = await getAuthSession();
  const userId = session?.user.id;
  if (!userId) return UNAVAILABLE;
  if (!(await readUserIsOrgMember(userId, id))) return UNAVAILABLE;
  let rows: { rows?: { name: string | null }[] };
  try {
    rows = await betterAuthDb.execute<{ name: string | null }>(sql`
      SELECT name FROM public."organization" WHERE id = ${id} LIMIT 1
    `);
  } catch {
    return { state: "blank" };
  }
  const row = rows.rows?.[0];
  if (!row) return UNAVAILABLE;
  return allowedName(row.name);
}

/**
 * The entity name a scope's page header and crumb read, as the typed answer.
 *
 * The workspace and the personal scope are not id-bearing entities: their names
 * are fixed by the drawing itself ("The page's heading reads Workspace"), so
 * they need no read and disclose nothing.
 */
export async function readScopeSurfaceEntityName(
  scope: ScopeSurfaceRef,
): Promise<ScopeSurfaceEntityName> {
  try {
    switch (scope.kind) {
      case "workspace":
      case "personal":
        return UNAVAILABLE;
      case "project":
        return await readProjectName(scope.id);
      case "team":
        return await readTeamName(scope.id);
      case "organization":
        return await readOrganizationName(scope.id);
    }
  } catch {
    // A name is a convenience on this surface, never its subject: a store
    // failure must not take the page down. A failure before the access decision
    // tells the reader nothing, so the header and the crumb fall back to the kind.
    return UNAVAILABLE;
  }
}
