"use server";

// ---------------------------------------------------------------------------
// Project permissions tab server actions.
//
// Authorization contract:
//   - addProjectCoOwnerAction(projectId, userId)      → project.manageMembers
//   - removeProjectCoOwnerAction(projectId, userId)   → project.manageMembers
//                                                        + last-owner guard
//   - searchWorkspaceUsersForProject(projectId, query) → owner-or-coowner-or-admin
//
// The authorization gate is always `enforceResourceAccess` on the live row.
// ---------------------------------------------------------------------------

import { and, eq, ilike, inArray, notInArray, or } from "drizzle-orm";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthMembers,
  betterAuthOrganizations,
  betterAuthUsers,
} from "@/lib/better-auth-db";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import {
  addProjectCoOwner,
  readProjectCoOwners,
  removeProjectCoOwner,
} from "@/lib/project-co-owners-store";
import { readProjectById } from "@/lib/projects-store-dao";

// Server-action wrappers around the project_access_* MCP primitives. These
// call the handlers in-process and stamp the actor with `projectGrants` so
// `assertProjectGrantRole` inside each handler can authorize via project
// grants.
import {
  handlers as projectsHandlers,
} from "@cinatra-ai/projects";
import {
  listTeamsForOrg,
  readProjectGrantsForUser,
  readTeamsForUser,
} from "@/lib/better-auth-db";
import { resolveOrgRoleForSession } from "@/lib/auth-session";
import { toIlikePattern } from "./grant-candidates";
import type {
  ProjectGrant,
  ProjectRole,
  ProjectAccessSource,
} from "@/lib/authz/actor-context";

// `actorFromSession` lives at `@/lib/authz/build-actor-context`.

async function loadProjectAndAuthorize(
  projectId: string,
  op: "project.read" | "project.update" | "project.manageMembers",
) {
  const session = await requireAuthSession();
  const actor = actorFromSession(session);

  if (!projectId) {
    throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
  }

  const project = await readProjectById(projectId);
  const coOwners = project ? await readProjectCoOwners(project.id) : [];

  await enforceResourceAccess(
    project
      ? {
          resourceType: "project",
          resourceId: project.id,
          // Use the row's tenant id, not the actor's.
          organizationId: project.organizationId,
          ownerLevel: normalizeOwnerLevel(project.ownerLevel),
          ownerId: project.ownerId,
          visibility: null,
          coOwnerUserIds: coOwners.map((c) => c.userId),
        }
      : null,
    actor,
    op,
  );

  return { session, actor, project: project!, coOwners };
}

// ---------------------------------------------------------------------------
// addProjectCoOwnerAction
// ---------------------------------------------------------------------------
export async function addProjectCoOwnerAction(
  projectId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { session, actor, project } = await loadProjectAndAuthorize(
      projectId,
      "project.manageMembers",
    );
    if (!userId || userId === project.ownerId) {
      return { ok: false, error: "invalid_user" };
    }

    // ensure the candidate user is a member of the actor's
    // active organization before granting co-ownership. Without this
    // check, an admin could share a project across tenant boundaries by
    // pasting any Better Auth user id. We use the actor's active org as
    // the scope boundary because `cinatra.projects` has no
    // `organization_id` column today. Once projects carry their own
    // organization id, this guard should switch to `project.organizationId`.
    const orgId = actor.organizationId ?? null;
    if (orgId) {
      const targetMembership = await betterAuthDb
        .select({ id: betterAuthMembers.id })
        .from(betterAuthMembers)
        .where(
          and(
            eq(betterAuthMembers.userId, userId),
            eq(betterAuthMembers.organizationId, orgId),
          ),
        )
        .limit(1);
      if (targetMembership.length === 0) {
        return { ok: false, error: "user_not_in_org" };
      }
    }

    await addProjectCoOwner(project.id, userId, session.user.id);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// removeProjectCoOwnerAction — co-owner removal (project owner is immutable
// through this action; ownership transfer would need its own dedicated path).
//
// `isLastOwner` checks the `projects.owner_id === userId AND coOwnerCount === 0`
// invariant, but this action only mutates `project_co_owners`, never
// `projects.owner_id`. That guard cannot fire usefully through this path.
// ---------------------------------------------------------------------------
export async function removeProjectCoOwnerAction(
  projectId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { project } = await loadProjectAndAuthorize(
      projectId,
      "project.manageMembers",
    );
    await removeProjectCoOwner(project.id, userId);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// searchWorkspaceUsersForProject — typeahead for the AddCoOwner combobox.
// ---------------------------------------------------------------------------
export type SharingCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export async function searchWorkspaceUsersForProject(
  projectId: string,
  query: string,
): Promise<{ ok: true; results: SharingCandidate[] } | { ok: false; error: string }> {
  const session = await requireAuthSession().catch(() => null);
  if (!session) return { ok: false, error: "unauthorized" };
  const callerId = session.user?.id ?? null;
  if (!callerId) return { ok: false, error: "unauthorized" };

  const project = await readProjectById(projectId);
  if (!project) return { ok: false, error: "not_found" };

  const isAdmin = isPlatformAdmin(session);
  const coOwners = await readProjectCoOwners(project.id);
  const isOwner = project.ownerId === callerId;
  const isCoOwner = coOwners.some((c) => c.userId === callerId);
  if (!isAdmin && !isOwner && !isCoOwner) {
    return { ok: false, error: "forbidden" };
  }

  const excludeIds = [project.ownerId, callerId, ...coOwners.map((c) => c.userId)].filter(
    (id): id is string => Boolean(id),
  );

  const trimmed = query.trim();
  // Escape the LIKE/ILIKE escape character (backslash) FIRST, then the `%`/`_`
  // wildcards, all via the single character class `[\\%_]`. Postgres ILIKE uses
  // backslash as the default ESCAPE char; without escaping a user-supplied `\`
  // the pattern semantics drift (e.g. `\%` would stop being a literal match).
  const like = trimmed.length > 0 ? `%${trimmed.replace(/[\\%_]/g, "\\$&")}%` : null;

  // limit the typeahead to users who are members of the caller's
  // active organization. Without this filter, any caller could
  // enumerate every user across every tenant via name/email substring
  // search. Until projects carry an `organization_id` column,
  // we use the caller's active org as the boundary.
  const sessionOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const baseQuery = sessionOrgId
    ? betterAuthDb
        .select({
          id: betterAuthUsers.id,
          name: betterAuthUsers.name,
          email: betterAuthUsers.email,
          image: betterAuthUsers.image,
        })
        .from(betterAuthUsers)
        .innerJoin(
          betterAuthMembers,
          and(
            eq(betterAuthMembers.userId, betterAuthUsers.id),
            eq(betterAuthMembers.organizationId, sessionOrgId),
          ),
        )
    : betterAuthDb
        .select({
          id: betterAuthUsers.id,
          name: betterAuthUsers.name,
          email: betterAuthUsers.email,
          image: betterAuthUsers.image,
        })
        .from(betterAuthUsers);

  const rows = await baseQuery
    .where(
      and(
        excludeIds.length > 0 ? notInArray(betterAuthUsers.id, excludeIds) : undefined,
        like !== null
          ? or(ilike(betterAuthUsers.name, like), ilike(betterAuthUsers.email, like))
          : undefined,
      ),
    )
    .orderBy(betterAuthUsers.name)
    .limit(20);

  return {
    ok: true,
    results: rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.email ?? "Unknown",
      email: r.email ?? "",
      image: r.image ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// readProjectOwnerViews — server helper used by the page RSC to enrich
// the resource-owner + co-owner ids with Better Auth display info.
// ---------------------------------------------------------------------------
export type OwnerView = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

export async function readProjectOwnerViews(
  ownerId: string,
  coOwnerUserIds: string[],
): Promise<{ owner: OwnerView | null; coOwners: OwnerView[] }> {
  const allIds = [ownerId, ...coOwnerUserIds].filter((id): id is string => Boolean(id));
  if (allIds.length === 0) return { owner: null, coOwners: [] };

  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
    })
    .from(betterAuthUsers)
    .where(inArray(betterAuthUsers.id, allIds));

  const byId = new Map(rows.map((u) => [u.id, u]));
  const toView = (id: string): OwnerView => {
    const u = byId.get(id);
    return {
      userId: id,
      name: u?.name ?? u?.email ?? "Unknown",
      email: u?.email ?? "",
      image: u?.image ?? null,
    };
  };

  return {
    owner: ownerId ? toView(ownerId) : null,
    coOwners: coOwnerUserIds.map(toView),
  };
}

// ---------------------------------------------------------------------------
// project_access_* server-action wrappers.
//
// Each wrapper:
//   1. Loads the session and resolves the actor's `projectGrants` via the
//      same path the MCP registry uses.
//   2. Synthesizes a `PrimitiveActorContext`-shaped object with `userId`,
//      `orgId`, `platformRole`, `roles`, `teamIds`, `projectIds`, and
//      `projectGrants` stamped so `assertProjectGrantRole` inside the
//      handler can authorize.
//   3. Forwards the call to the handler in-process — no HTTP round-trip,
//      no MCP transport ceremony.
// ---------------------------------------------------------------------------

type PrincipalLevel = "user" | "team" | "organization" | "workspace";

async function buildProjectActor(): Promise<{
  actor: Record<string, unknown>;
  session: Awaited<ReturnType<typeof requireAuthSession>>;
}> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  const platformAdmin = isPlatformAdmin(session);
  const teamRows = userId && orgId ? await readTeamsForUser(userId, orgId) : [];
  const teamIds = teamRows.map((t) => t.id);
  const orgRole = userId && orgId ? await resolveOrgRoleForSession(session) : null;
  const grants: ProjectGrant[] =
    userId && orgId
      ? await readProjectGrantsForUser(userId, orgId, {
          teamIds,
          ...(orgRole ? { orgRole } : {}),
        })
      : [];

  const actor: Record<string, unknown> = {
    actorType: "human",
    source: "ui",
    userId,
  };
  if (orgId) {
    actor.orgId = orgId;
    actor.organizationId = orgId;
  }
  if (platformAdmin) {
    actor.platformRole = "platform_admin";
    actor.roles = ["platform_admin"];
  }
  if (teamIds.length > 0) actor.teamIds = teamIds;
  actor.projectGrants = grants;
  actor.projectIds = grants.map((g) => g.projectId);
  return { actor, session };
}

export type ProjectAccessRow = {
  principalLevel: PrincipalLevel;
  principalId: string;
  role: ProjectRole;
  grantedBy: string;
  grantedAt: Date;
  accessSource: ProjectAccessSource;
};

export async function grantProjectAccessAction(
  projectId: string,
  principalLevel: PrincipalLevel,
  principalId: string,
  role: "read" | "write" | "admin",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { actor } = await buildProjectActor();
    const result = await projectsHandlers["project_access_grant"]({
      primitiveName: "project_access_grant",
      input: { projectId, principalLevel, principalId, role },
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_access_grant"]
      >[0]["actor"],
      mode: "deterministic",
    });
    return result as { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export async function revokeProjectAccessAction(
  projectId: string,
  principalLevel: PrincipalLevel,
  principalId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { actor } = await buildProjectActor();
    const result = await projectsHandlers["project_access_revoke"]({
      primitiveName: "project_access_revoke",
      input: { projectId, principalLevel, principalId },
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_access_revoke"]
      >[0]["actor"],
      mode: "deterministic",
    });
    return result as { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export async function listProjectAccessAction(
  projectId: string,
): Promise<{ ok: true; items: ProjectAccessRow[] } | { ok: false; error: string }> {
  try {
    const { actor } = await buildProjectActor();
    const result = (await projectsHandlers["project_access_list"]({
      primitiveName: "project_access_list",
      input: { projectId },
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_access_list"]
      >[0]["actor"],
      mode: "deterministic",
    })) as { items: ProjectAccessRow[] };
    return { ok: true, items: result.items };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

// ---------------------------------------------------------------------------
// Grant-candidate actions for the ProjectAccessSection pickers
// (cinatra#1505 / #1509 §4.2).
//
// Candidates are NEVER derived from the viewer's own memberships
// (`availableScopes` — the codex F6 trap: a project admin who is not in a
// team could never grant to it). Instead every candidate action is
//   - gated on the SAME authority as `grantProjectAccessAction` (project
//     admin/owner via projectGrants, or platform admin — the
//     `assertProjectAdmin` precedent in customers/actions.ts), and
//   - bounded by the PROJECT's `organizationId`, never the viewer's org
//     memberships.
// The pickers these feed are affordances only — final authority stays
// server-side in `grantProjectAccessAction` (project_access_grant handler).
// ---------------------------------------------------------------------------

/**
 * Authority gate for the grant-candidate reads: project admin/owner
 * (effectiveRole via projectGrants) or platform admin — the same authority
 * `project_access_grant` enforces, resolved the same way `buildProjectActor`
 * stamps it. Throws AuthzError("forbidden") otherwise.
 *
 * Fails closed WITHOUT an existence oracle: a missing project and missing
 * authority raise the identical error, so probing ids reveals nothing.
 */
async function assertProjectGrantAuthority(projectId: string): Promise<{
  project: NonNullable<Awaited<ReturnType<typeof readProjectById>>>;
}> {
  const forbidden = () =>
    new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Project admin required.",
    });

  // `requireAuthSession` throws Next's redirect sentinel when there is no
  // session; the candidate actions' generic try/catch must never swallow it
  // into an `{ok:false}` payload. Adopt the `searchWorkspaceUsersForProject`
  // precedent: coerce a missing session to null here and fail closed as the
  // same typed AuthzError as every other authority failure.
  const session = await requireAuthSession().catch(() => null);
  if (!session) throw forbidden();
  const userId = session.user.id;

  const project = projectId ? await readProjectById(projectId) : null;
  if (!project) throw forbidden();

  // Platform admin is an INDEPENDENT authority (buildProjectActor stamps
  // `platformRole` for the grant handler with or without an active org), so
  // it is checked before the active-org requirement — the org is only needed
  // to resolve the projectGrants branch below (codex 1505-r1 High).
  if (isPlatformAdmin(session)) return { project };

  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  if (!orgId) throw forbidden();

  const teamRows = await readTeamsForUser(userId, orgId).catch(() => []);
  const orgRole = await resolveOrgRoleForSession(session).catch(() => null);
  const grants = await readProjectGrantsForUser(userId, orgId, {
    teamIds: teamRows.map((t) => t.id),
    ...(orgRole ? { orgRole } : {}),
  }).catch(() => []);
  const here = grants.find((g) => g.projectId === projectId);
  if (!here || (here.effectiveRole !== "admin" && here.effectiveRole !== "owner")) {
    throw forbidden();
  }
  return { project };
}

export type GrantUserCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

/**
 * User candidates for a project access grant. Clone-basis:
 * `searchWorkspaceUsersForProject` (org-boundary join, ILIKE escaping,
 * limit 20) with two deliberate differences (§4.2):
 *   - NO owner/co-owner/self exclusion — they are legitimate grant
 *     principals; already-granted principals (which include the implicit
 *     owner row) are excluded client-side from `projectAccessRows`;
 *   - the boundary is the PROJECT's `organizationId`, not the caller's
 *     active org.
 * An org-less project has no boundary to search within — fail closed to an
 * empty candidate list (the manual-ID escape hatch remains available).
 */
export async function searchProjectGrantUserCandidates(
  projectId: string,
  query: string,
): Promise<{ ok: true; results: GrantUserCandidate[] } | { ok: false; error: string }> {
  try {
    const { project } = await assertProjectGrantAuthority(projectId);
    const boundaryOrgId = project.organizationId ?? null;
    if (!boundaryOrgId) return { ok: true, results: [] };

    const like = toIlikePattern(query);
    const rows = await betterAuthDb
      .select({
        id: betterAuthUsers.id,
        name: betterAuthUsers.name,
        email: betterAuthUsers.email,
        image: betterAuthUsers.image,
      })
      .from(betterAuthUsers)
      .innerJoin(
        betterAuthMembers,
        and(
          eq(betterAuthMembers.userId, betterAuthUsers.id),
          eq(betterAuthMembers.organizationId, boundaryOrgId),
        ),
      )
      .where(
        like !== null
          ? or(ilike(betterAuthUsers.name, like), ilike(betterAuthUsers.email, like))
          : undefined,
      )
      .orderBy(betterAuthUsers.name)
      .limit(20);

    return {
      ok: true,
      results: rows.map((r) => ({
        id: r.id,
        name: r.name ?? r.email ?? "Unknown",
        email: r.email ?? "",
        image: r.image ?? null,
      })),
    };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export type GrantTeamCandidate = { id: string; name: string };

/**
 * Team candidates for a project access grant: EVERY team in the project's
 * org, server-listed (§4.2 — deliberately NOT the viewer's memberships).
 * `listTeamsForOrg` ignores caller memberships by design and requires a role
 * gate — `assertProjectGrantAuthority` is that gate.
 */
export async function listProjectGrantTeamCandidates(
  projectId: string,
): Promise<{ ok: true; teams: GrantTeamCandidate[] } | { ok: false; error: string }> {
  try {
    const { project } = await assertProjectGrantAuthority(projectId);
    if (!project.organizationId) return { ok: true, teams: [] };
    const teams = await listTeamsForOrg(project.organizationId);
    return { ok: true, teams };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export type GrantOrgCandidate = { id: string; name: string };

/**
 * The fixed organization-level candidate: the PROJECT's own org, by name
 * (§4.2). `organization: null` for an org-less project — the level then has
 * nothing to grant to (fail closed; manual-ID escape hatch remains).
 */
export async function readProjectGrantOrgCandidate(
  projectId: string,
): Promise<
  { ok: true; organization: GrantOrgCandidate | null } | { ok: false; error: string }
> {
  try {
    const { project } = await assertProjectGrantAuthority(projectId);
    if (!project.organizationId) return { ok: true, organization: null };
    const rows = await betterAuthDb
      .select({
        id: betterAuthOrganizations.id,
        name: betterAuthOrganizations.name,
      })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, project.organizationId))
      .limit(1);
    const org = rows[0];
    return {
      ok: true,
      organization: org
        ? // §3.2 unknown-entity fallback — never an empty/raw-id rendering.
          { id: org.id, name: org.name ?? "Unknown organization" }
        : null,
    };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}
