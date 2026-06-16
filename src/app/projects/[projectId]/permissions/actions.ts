"use server";

// ---------------------------------------------------------------------------
// Project permissions tab server actions.
//
// Authorization contract:
//   - addProjectCoOwnerAction(projectId, userId)      → project.manageMembers
//   - removeProjectCoOwnerAction(projectId, userId)   → project.manageMembers
//                                                        + last-owner guard
//   - updateProjectScopeAction(projectId, ownerLevel, ownerId)
//                                                       → project.update
//                                                        + assertScopeRatchet
//   - searchWorkspaceUsersForProject(projectId, query) → owner-or-coowner-or-admin
//
// The authorization gate is always `enforceResourceAccess` on the live row.
// ---------------------------------------------------------------------------

import { and, eq, ilike, inArray, notInArray, or } from "drizzle-orm";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthMembers,
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
// `assertScopeRatchet` import + `updateProject` (only used by the disabled
// `updateProjectScopeAction`) are intentionally absent from this module.

// Server-action wrappers around the project_access_* MCP primitives. These
// call the handlers in-process and stamp the actor with `projectGrants` so
// `assertProjectGrantRole` inside each handler can authorize via project
// grants.
import {
  handlers as projectsHandlers,
} from "@cinatra-ai/projects";
import {
  readProjectGrantsForUser,
  readTeamsForUser,
} from "@/lib/better-auth-db";
import { resolveOrgRoleForSession } from "@/lib/auth-session";
import type {
  ProjectGrant,
  ProjectRole,
  ProjectAccessSource,
} from "@/lib/authz/actor-context";

type OwnerLevel = "user" | "team" | "organization" | "workspace";

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
// updateProjectScopeAction — ratchet-only ownership change.
// ---------------------------------------------------------------------------
// `updateProjectScopeAction` is DISABLED.
// The promotion-ratchet (one-shot upward ownership transfer) is
// retired in the N:M access model. Ownership transfer is intentionally
// not exposed; per-project access is managed via the
// `project_access_grant` / `project_access_revoke` MCP primitives instead. The
// function stays exported because the permissions tab UI imports it, but it
// throws on call so no transfer can land.
export async function updateProjectScopeAction(
  _projectId: string,
  _ownerLevel: OwnerLevel,
  _ownerId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  throw new Error("ownership ratchet removed — see /projects/[id]/permissions");
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
