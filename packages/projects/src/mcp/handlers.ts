import "server-only";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { toPgTextArrayLiteral } from "@/lib/pg-array";

/**
 * Mirrors the SQL slug normalizer.
 * Same semantics: trim, collapse non-alphanum runs, fallback "item", cap 60.
 */
function normalizeProjectSlug(input: string): string {
  const stripped = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (stripped || "item").slice(0, 60);
}
import type { PrimitiveActorContext, PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { projects, projectsDb } from "@/lib/projects-store";
import { readProjectById, updateProject } from "@/lib/projects-store-dao";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import type { ProjectGrant, ProjectRole, ProjectAccessSource } from "@/lib/authz/actor-context";
import * as schemas from "./schemas";
// Write-block enforcement for project binding entry points.
// Bindings MUST reject when the
// target project is archived; the helper composes existence + archived
// + role gates so the call is a single chokepoint.
import { assertProjectWritable } from "@/lib/project-writable";

// Scope-ratchet import + call removed from this MCP surface.
// Leaving the ratchet alive while the N:M model is active means the stack
// carries two incompatible project models. The ratchet helper module at
// `src/app/projects/scope-ratchet.ts` and its server-action callers
// (`createProjectAction`, `updateProjectScopeAction`,
// `permissions/actions.ts`) are intentionally left in place — those are
// SERVER-ACTION callers that are NOT on the MCP surface. This boundary only
// forbids the ratchet symbol in THIS file
// (packages/projects/src/mcp/handlers.ts).
//
// `projects_delete` handler and `deleteProject` DAO import removed from this
// MCP surface. Archive lifecycle is handled by projects_archive /
// projects_unarchive. The DAO
// helper `deleteProject` in `@/lib/projects-store-dao` is retained for
// server actions (`deleteProjectAction`, `deleteProjectAsPlatformAdmin`)
// because UI/CLI/server-action delete behavior is outside this MCP boundary.

// ---------------------------------------------------------------------------
// @cinatra-ai/projects MCP handlers.
//
// Mirrors @cinatra-ai/objects handlers shape:
//   - every primitive routes through `enforceResourceAccess`
//   - `projects_list` post-filters via the kernel (drop denied rows
//     silently — never throw mid-list)
//   - cross-tenant `projects_get` returns 404-hidden via the gate
//
// Auth boundary: actor.userId / actor.orgId arrive via the request
// context (populated by the MCP transport from the Better Auth session).
// ---------------------------------------------------------------------------

type ActorExt = {
  userId: string | null;
  orgId: string | null;
};

function getActorExt(actor: PrimitiveActorContext): ActorExt {
  const ext = actor as unknown as Record<string, unknown>;
  const ctx = mcpRequestContextStorage.getStore();
  return {
    userId: actor.userId ?? null,
    orgId: (ext["orgId"] as string | null | undefined) ?? ctx?.orgId ?? null,
  };
}

// Anonymous-actor guard. An actor without userId is unauthenticated
// at the projects MCP boundary — `enforceResourceAccess` would otherwise
// fall through to the kernel's deny path, which still produces 403 but
// with an inconsistent code path that obscures why the request was
// rejected. Reject early with an explicit forbidden response. System /
// worker actors that need anonymous access must add their own primitive.
function assertAuthenticatedActor(actor: PrimitiveActorContext): void {
  if (actor.userId == null) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Authentication required.",
    });
  }
}

// Project access and binding authz gate.
//
// The project_access_* / bindings_* handlers cannot gate solely with generic
// `enforceResourceAccess(... "project.manageMembers" / "project.update")`
// because that kernel does NOT enforce `ProjectRole` semantics, so:
//   - same-org legacy admins could over-grant project_access rows
//   - explicit `project_access.role='admin'` / 'write' could be under-granted
// because the kernel doesn't read `actor.projectGrants`.
//
// Replace the legacy gate with this explicit role-rank check against the
// caller's canonical project grant (set by `actorContextFromMcpRequest`
// / `resolveActorRoleExtensionFromSession`).
//
//   - `read`  permits list / check
//   - `write` permits binding create / update / delete
//   - `admin` permits grant / revoke (membership management)
//   - `owner` permits admin-role escalation (project_access.role='admin'),
//     enforced inline in `project_access_grant`
//
// `platform_admin` bypass is preserved (the kernel still grants
// platform_admin operators the same blast radius — projects moderation /
// incident response paths).
const PROJECT_ROLE_RANK = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
} as const;

function assertProjectGrantRole(
  actor: PrimitiveActorContext,
  projectId: string,
  required: "read" | "write" | "admin" | "owner",
): void {
  // platform_admin bypass — same shape as the kernel's
  // `enforce.ts:67` short-circuit. Stamped by upstream code paths that
  // verified the session role at the request boundary.
  if ((actor as unknown as { platformRole?: string }).platformRole === "platform_admin") {
    return;
  }
  const grants: ProjectGrant[] = Array.isArray(
    (actor as unknown as { projectGrants?: ProjectGrant[] }).projectGrants,
  )
    ? (actor as unknown as { projectGrants: ProjectGrant[] }).projectGrants
    : [];
  const grant = grants.find((g) => g.projectId === projectId);
  if (!grant) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `No project_access for ${projectId}`,
    });
  }
  if (PROJECT_ROLE_RANK[grant.effectiveRole] < PROJECT_ROLE_RANK[required]) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Requires ${required}; have ${grant.effectiveRole}`,
    });
  }
}

// The resource's organizationId is the project row's
// `organization_id` column (the row's tenant), NOT the requesting
// actor's active org. Passing `actor.organizationId` here would make
// the kernel cross-org guard self-referential (`actor.org === actor.org`
// is always true) and silently disable tenant isolation. The
// `actorOrgId` argument stays in the signature for the legacy-NULL
// fallback: when an older row has no organizationId,
// and we degrade gracefully by leaving the envelope's organizationId
// as `null` — the kernel treats null as "no tenant constraint", which
// preserves behavior for those rows but means the guard
// cannot fire on them. (A backfill is the operator's call.)
function buildProjectResourceCheck(row: {
  id: string;
  ownerLevel: string;
  ownerId: string;
  visibility: string | null;
  organizationId: string | null;
}, _actorOrgId: string | null, coOwnerUserIds: string[]): ResourceForAccessCheck {
  return {
    resourceType: "project",
    resourceId: row.id,
    organizationId: row.organizationId,
    ownerLevel: normalizeOwnerLevel(row.ownerLevel),
    ownerId: row.ownerId,
    visibility: row.visibility === "discoverable" ? "public" : "private",
    coOwnerUserIds,
  };
}

export function createProjectsPrimitiveHandlers() {
  return {
    "projects_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsGetSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);
      const { orgId } = getActorExt(request.actor);
      const row = await readProjectById(input.projectId);
      const coOwners = row ? await readProjectCoOwners(row.id) : [];
      await enforceResourceAccess(
        row ? buildProjectResourceCheck(row, orgId, coOwners.map((c) => c.userId)) : null,
        request.actor,
        "project.read",
      );
      return { project: row };
    },

    "projects_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsListSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);

      // Replace the user-owned-only scan with a union derived from
      // `actor.projectGrants` (the canonical visibility axis resolved and
      // stamped onto the actor in registry.ts). Each
      // row returns `effectiveRole` + `accessSource` from the matched
      // grant. Default `archived=false`: filter `archived_at IS NULL`
      // unless `includeArchived` is true.
      //
      // The resolver already runs in `actorContextFromMcpRequest` /
      // `resolveActorRoleExtensionFromSession`; if a caller appears here
      // without grants (legacy sync path), treat as "no visibility" and
      // return an empty list (defence-in-depth — never throw mid-list).
      const grants: ProjectGrant[] = Array.isArray(
        (request.actor as unknown as { projectGrants?: ProjectGrant[] }).projectGrants,
      )
        ? ((request.actor as unknown as { projectGrants: ProjectGrant[] }).projectGrants)
        : [];

      if (grants.length === 0) {
        return { items: [] as Array<{
          id: string;
          name: string;
          description: string | null;
          ownerLevel: string;
          ownerId: string;
          organizationId: string | null;
          visibility: string;
          slug: string;
          createdAt: Date;
          archivedAt: Date | null;
          effectiveRole: ProjectRole;
          accessSource: ProjectAccessSource;
        }> };
      }

      // Build a deterministic ordering by project id for SQL — we re-sort
      // by createdAt DESC in JS after merging with the grant metadata.
      // Using raw SQL (not the Drizzle ORM `select`) because:
      //   1) the union returns rows MULTIPLIED by `effectiveRole`/
      //      `accessSource` from the grants; the cleanest join is in JS.
      //   2) `archived_at` is not yet in the Drizzle binding.
      const grantById = new Map<string, ProjectGrant>();
      for (const g of grants) grantById.set(g.projectId, g);
      const projectIds = grants.map((g) => g.projectId);

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const result = await projectsDb.execute<{
        id: string;
        name: string;
        description: string | null;
        owner_level: string;
        owner_id: string;
        organization_id: string | null;
        visibility: string;
        slug: string;
        created_at: Date;
        archived_at: Date | null;
      }>(sql`
        SELECT id, name, description, owner_level, owner_id, organization_id,
               visibility, slug, created_at, archived_at
          FROM "${sql.raw(schema)}"."projects"
         WHERE id = ANY(${toPgTextArrayLiteral(projectIds)}::text[])
           ${input.includeArchived ? sql`` : sql`AND archived_at IS NULL`}
         ORDER BY created_at DESC
         LIMIT ${input.limit}
      `);

      // Apply optional ownerLevel/ownerId predicate filters in JS — these
      // are post-filters on top of the actor's resolved visibility set.
      const rows = result.rows
        .filter((r) => !input.ownerLevel || r.owner_level === input.ownerLevel)
        .filter((r) => !input.ownerId || r.owner_id === input.ownerId);

      const items = rows.map((r) => {
        const grant = grantById.get(r.id);
        // grant MUST exist (we queried by `id = ANY(grants[*])`), but
        // narrow defensively so the type stays sound.
        const effectiveRole: ProjectRole = grant?.effectiveRole ?? "read";
        const accessSource: ProjectAccessSource = grant?.accessSource ?? "user";
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          ownerLevel: r.owner_level,
          ownerId: r.owner_id,
          organizationId: r.organization_id,
          visibility: r.visibility,
          slug: r.slug,
          createdAt: r.created_at,
          archivedAt: r.archived_at,
          effectiveRole,
          accessSource,
        };
      });

      // Pagination is not yet implemented — the schema does not
      // declare `cursor`, so the response intentionally omits
      // `nextCursor`. Add both back in lockstep when opaque-cursor
      // pagination lands.
      return { items };
    },

    "projects_create": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsCreateSchema.parse(request.input);
      const { userId, orgId } = getActorExt(request.actor);

      // On create, the row's organizationId equals the actor's
      // active org (a project always originates inside the requester's
      // tenant). Passing it here lets the kernel cross-org guard evaluate
      // any non-trivial future policy that requires `actor.org ===
      // resource.org` — today both sides match because the resource
      // doesn't exist yet, but the envelope shape stays correct for
      // when a future caller proxies a cross-org create.
      await enforceResourceAccess(
        {
          resourceType: "project",
          resourceId: "<new>",
          organizationId: orgId,
          ownerLevel: input.ownerLevel,
          ownerId: input.ownerId,
          visibility: input.visibility === "discoverable" ? "public" : "private",
        },
        request.actor,
        "project.create",
      );

      // Promotion-ratchet call removed. The authenticated-user guard is
      // preserved (an MCP caller without an auth-derived userId cannot create
      // a project even though
      // enforceResourceAccess already returned because the `project.create`
      // permission is granted to anonymous service contexts in some kernel
      // paths — defence-in-depth).
      if (!userId) {
        throw new AuthzError({
          statusCode: 403,
          reason: "forbidden",
          message: "Creating a project requires an authenticated user.",
        });
      }

      // Ownership-authority check.
      // Generic `project.create` is granted to org members, so without this
      // check a regular member
      // could submit ANY `ownerLevel/ownerId` for team/org/workspace
      // ownership through MCP. Enforce explicit authority:
      //   - `user`-owned: must be self (the auth-derived userId)
      //   - `team`-owned: actor must hold `team_admin` for the target team
      //   - `organization`-owned: ownerId must match actor's active org
      //     AND actor must be `org_admin` / `org_owner`
      //   - `workspace`-owned: requires `platform_admin`
      //
      // `platform_admin` bypass for all non-self tiers — projects
      // moderation / incident response paths need to be able to plant a
      // project at any tier.
      const actorRoles = request.actor as unknown as {
        platformRole?: "platform_admin" | "member";
        orgRole?: "org_owner" | "org_admin" | "member";
        teamRoles?: Record<string, "team_admin" | "member">;
        organizationId?: string | null;
      };
      const isPlatformAdmin = actorRoles.platformRole === "platform_admin";

      if (input.ownerLevel === "user" && input.ownerId !== userId) {
        throw new AuthzError({
          statusCode: 403,
          reason: "forbidden",
          message: "user-owned project must be self",
        });
      }
      if (input.ownerLevel === "team" && !isPlatformAdmin) {
        const teamRole = actorRoles.teamRoles?.[input.ownerId];
        if (teamRole !== "team_admin") {
          throw new AuthzError({
            statusCode: 403,
            reason: "forbidden",
            message: "team-owned requires team_admin",
          });
        }
      }
      if (input.ownerLevel === "organization" && !isPlatformAdmin) {
        if (input.ownerId !== actorRoles.organizationId) {
          throw new AuthzError({
            statusCode: 403,
            reason: "forbidden",
            message: "org-owned requires matching active org",
          });
        }
        const orgRole = actorRoles.orgRole;
        if (orgRole !== "org_admin" && orgRole !== "org_owner") {
          throw new AuthzError({
            statusCode: 403,
            reason: "forbidden",
            message: "org-owned requires org_admin/org_owner",
          });
        }
      }
      if (input.ownerLevel === "workspace" && !isPlatformAdmin) {
        throw new AuthzError({
          statusCode: 403,
          reason: "forbidden",
          message: "workspace-owned requires platform_admin",
        });
      }

      const id = randomUUID();
      // Derive a slug from the project name with retry-on-conflict for
      // uniqueness within (owner_level, owner_id). The DB enforces this via
      // projects_slug_uniq; we surface the same error code 23505 if even 100
      // increments fail (extremely improbable).
      const baseSlug = normalizeProjectSlug(input.name);
      let attemptSlug = baseSlug;
      // Track success so we throw rather than silently return a
      // non-existent project id when every retry collides.
      let inserted = false;
      for (let n = 2; n <= 100; n++) {
        try {
          await projectsDb.insert(projects).values({
            id,
            name: input.name,
            description: input.description ?? null,
            ownerLevel: input.ownerLevel,
            ownerId: input.ownerId,
            // Persist the row's tenant boundary so subsequent reads
            // can populate the kernel's resource.organizationId from the
            // row itself, not from the requesting actor. `orgId` is null for
            // workspace-tier projects (which span the platform instance);
            // every other tier must have an org id for the cross-org guard
            // to be effective.
            organizationId: orgId,
            visibility: input.visibility,
            slug: attemptSlug,
          });
          inserted = true;
          break;
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string; message?: string };
          if (pgErr?.code === "23505" && /projects_slug_uniq/.test(String(pgErr.constraint ?? pgErr.message ?? ""))) {
            attemptSlug = `${baseSlug.slice(0, 60 - String(n).length - 1)}-${n}`;
            continue;
          }
          throw err;
        }
      }
      if (!inserted) {
        throw new Error(
          `projects.slug: could not allocate a unique slug after 100 attempts ` +
            `(baseSlug="${baseSlug}", owner=${input.ownerLevel}:${input.ownerId}).`,
        );
      }
      return { id };
    },

    "projects_update": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsUpdateSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);
      const { orgId } = getActorExt(request.actor);

      const existing = await readProjectById(input.projectId);
      const coOwners = existing ? await readProjectCoOwners(existing.id) : [];

      await enforceResourceAccess(
        existing
          ? buildProjectResourceCheck(existing, orgId, coOwners.map((c) => c.userId))
          : null,
        request.actor,
        "project.update",
      );
      if (!existing) {
        // Defensive — gate above already 404-hides; this is the explicit
        // throw path for callers that bypass the gate via overrides.
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.visibility !== undefined) patch.visibility = input.visibility;
      // Ownership changes via projects_update are intentionally NOT supported
      // here — callers must go through the dedicated server-action ratchet
      // path. The schema accepts the fields for API symmetry but the handler
      // drops them.
      if (Object.keys(patch).length > 0) {
        await updateProject(existing.id, patch as never);
      }
      return { ok: true as const };
    },

    // -----------------------------------------------------------------------
    // projects_delete removed from this MCP surface; archive lifecycle uses
    // projects_archive / projects_unarchive.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // projects_archive primitive
    //
    // Idempotent archive flip: UPDATE projects SET archived_at = now()
    // WHERE id = $1 AND archived_at IS NULL. When the row is already
    // archived, the UPDATE matches zero rows and we return
    // `{ alreadyArchived: true }` instead of throwing. Admin/owner
    // authz via assertProjectGrantRole(..."admin").
    //
    // Audit row in `resource_project_moves` (resource_kind='project',
    // old/new project_id same id, reason='archive'). Records the
    // operator's intent so a later /projects/[id] timeline view can
    // surface "archived by X at T" alongside the move/audit history.
    // -----------------------------------------------------------------------
    "projects_archive": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsArchiveSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);
      const { userId } = getActorExt(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Authz: admin grant or owner.
      assertProjectGrantRole(request.actor, existing.id, "admin");

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const actorId = userId ?? "system";
      const reason = input.reason ?? "archive";

      // Idempotent: archive only when archived_at IS NULL. Returning
      // archivedAt lets callers display the operator-visible flip
      // timestamp. The audit row is INSERTed only when the UPDATE
      // actually wrote (a no-op should not pollute the audit table).
      const updateResult = await projectsDb.execute<{
        id: string;
        archived_at: Date;
      }>(sql`
        UPDATE "${sql.raw(schema)}"."projects"
           SET archived_at = now()
         WHERE id = ${existing.id}
           AND archived_at IS NULL
        RETURNING id, archived_at
      `);

      if (updateResult.rows.length === 0) {
        // Already archived → no-op, no audit row.
        return {
          ok: true as const,
          alreadyArchived: true as const,
          projectId: existing.id,
        };
      }

      const archivedAt = updateResult.rows[0]!.archived_at;
      // Audit row. resource_kind='project'; old/new project_id is the
      // SAME id (archive is a state flip, not a move between projects);
      // reason carries the operator annotation.
      await projectsDb.execute(sql`
        INSERT INTO "${sql.raw(schema)}"."resource_project_moves"
          (id, resource_kind, resource_id, old_project_id, new_project_id,
           actor_id, source_run_id, source_thread_id, reason)
        VALUES
          (gen_random_uuid()::text, 'project', ${existing.id},
           ${existing.id}, ${existing.id},
           ${actorId}, NULL, NULL, ${reason})
      `);

      return {
        ok: true as const,
        alreadyArchived: false as const,
        projectId: existing.id,
        archivedAt,
      };
    },

    // -----------------------------------------------------------------------
    // projects_unarchive primitive
    //
    // Symmetric idempotent unarchive: UPDATE projects SET archived_at =
    // NULL WHERE id = $1 AND archived_at IS NOT NULL. No-op + no audit
    // row when the project was already active.
    // -----------------------------------------------------------------------
    "projects_unarchive": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectsUnarchiveSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);
      const { userId } = getActorExt(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      assertProjectGrantRole(request.actor, existing.id, "admin");

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const actorId = userId ?? "system";
      const reason = input.reason ?? "unarchive";

      const updateResult = await projectsDb.execute<{ id: string }>(sql`
        UPDATE "${sql.raw(schema)}"."projects"
           SET archived_at = NULL
         WHERE id = ${existing.id}
           AND archived_at IS NOT NULL
        RETURNING id
      `);

      if (updateResult.rows.length === 0) {
        return {
          ok: true as const,
          alreadyActive: true as const,
          projectId: existing.id,
        };
      }

      await projectsDb.execute(sql`
        INSERT INTO "${sql.raw(schema)}"."resource_project_moves"
          (id, resource_kind, resource_id, old_project_id, new_project_id,
           actor_id, source_run_id, source_thread_id, reason)
        VALUES
          (gen_random_uuid()::text, 'project', ${existing.id},
           ${existing.id}, ${existing.id},
           ${actorId}, NULL, NULL, ${reason})
      `);

      return {
        ok: true as const,
        alreadyActive: false as const,
        projectId: existing.id,
      };
    },

    // -----------------------------------------------------------------------
    // project_access_* primitives.
    //
    // Pattern: mirror the existing projects_* primitives —
    //   1. parse with the new schema
    //   2. assert authenticated actor (the MCP boundary)
    //   3. fetch the project row (and co-owner set, for the kernel co-owner
    //      short-circuit on project.read/update/manageMembers)
    //   4. call enforceResourceAccess against `project.<op>`
    //   5. perform the write (raw SQL, since the new project_access /
    //      project_agent_template_bindings tables don't have a Drizzle
    //      binding yet).
    // -----------------------------------------------------------------------

    "project_access_grant": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectAccessGrantSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);
      const { userId } = getActorExt(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        // 404-hide before any authz decision so existence isn't leaked
        // when the row is missing.
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants`, NOT the legacy `project.manageMembers`
      // kernel gate, which doesn't enforce ProjectRole semantics.
      assertProjectGrantRole(request.actor, existing.id, "admin");

      // Reject attempts to insert the project's own owner as a project_access
      // row. Owner is computed from `projects.owner_level/owner_id`, NEVER
      // stored.
      if (
        input.principalLevel === existing.ownerLevel &&
        input.principalId === existing.ownerId
      ) {
        throw new AuthzError({
          statusCode: 400,
          reason: "owner_implicit",
          message:
            "Owner is implicit; cannot be granted via project_access.",
        });
      }

      // Admin-role escalation: only the project OWNER may grant role='admin'.
      // We resolve the actor's effective role for this project from
      // `actor.projectGrants`. `effectiveRole` === 'owner' iff the actor is
      // the implicit project owner; an admin grant from `project_access`
      // (role='admin') is NOT sufficient.
      if (input.role === "admin") {
        const grants: ProjectGrant[] = Array.isArray(
          (request.actor as unknown as { projectGrants?: ProjectGrant[] }).projectGrants,
        )
          ? (request.actor as unknown as { projectGrants: ProjectGrant[] }).projectGrants
          : [];
        const ownGrant = grants.find((g) => g.projectId === existing.id);
        if (!ownGrant || ownGrant.effectiveRole !== "owner") {
          throw new AuthzError({
            statusCode: 403,
            reason: "forbidden",
            message: "Only the project owner can grant role='admin'.",
          });
        }
      }

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const grantedBy = userId ?? "system";

      // INSERT ... ON CONFLICT (project_id, principal_level, principal_id)
      // DO UPDATE SET role = EXCLUDED.role (idempotent; updates the role
      // when re-granting to the same principal). granted_by/granted_at
      // are preserved on conflict (historical actor; the new actor is
      // only relevant for the role change).
      await projectsDb.execute(sql`
        INSERT INTO "${sql.raw(schema)}"."project_access"
          (project_id, principal_level, principal_id, role, granted_by)
        VALUES
          (${existing.id}, ${input.principalLevel}, ${input.principalId}, ${input.role}, ${grantedBy})
        ON CONFLICT (project_id, principal_level, principal_id)
          DO UPDATE SET role = EXCLUDED.role
      `);
      return { ok: true as const };
    },

    "project_access_revoke": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectAccessRevokeSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'admin'
      // (membership-management surface).
      assertProjectGrantRole(request.actor, existing.id, "admin");

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      await projectsDb.execute(sql`
        DELETE FROM "${sql.raw(schema)}"."project_access"
         WHERE project_id = ${existing.id}
           AND principal_level = ${input.principalLevel}
           AND principal_id = ${input.principalId}
      `);
      return { ok: true as const };
    },

    "project_access_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectAccessListSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'read'.
      assertProjectGrantRole(request.actor, existing.id, "read");

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const result = await projectsDb.execute<{
        principal_level: "user" | "team" | "organization" | "workspace";
        principal_id: string;
        role: "read" | "write" | "admin";
        granted_by: string;
        granted_at: Date;
      }>(sql`
        SELECT principal_level, principal_id, role, granted_by, granted_at
          FROM "${sql.raw(schema)}"."project_access"
         WHERE project_id = ${existing.id}
         ORDER BY principal_level, principal_id
      `);

      // Include the derived OWNER row (computed from projects.
      // owner_level/owner_id, never stored). The owner row is synthesized here
      // so callers see the full effective access picture.
      const ownerRow = {
        principalLevel: existing.ownerLevel as "user" | "team" | "organization" | "workspace",
        principalId: existing.ownerId,
        role: "owner" as const,
        grantedBy: existing.ownerId,
        // No granted_at for the owner (the owner is the row itself);
        // callers should distinguish via `role === 'owner'`.
        grantedAt: existing.createdAt,
        accessSource: "owner" as const,
      };

      const items = [
        ownerRow,
        ...result.rows.map((r) => ({
          principalLevel: r.principal_level,
          principalId: r.principal_id,
          role: r.role,
          grantedBy: r.granted_by,
          grantedAt: r.granted_at,
          accessSource: r.principal_level as ProjectAccessSource,
        })),
      ];

      return { items };
    },

    "project_access_check": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.projectAccessCheckSchema.parse(request.input);
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'read'.
      assertProjectGrantRole(request.actor, existing.id, "read");

      // Owner short-circuit: owner access is derived, not stored twice.
      if (
        input.principalLevel === existing.ownerLevel &&
        input.principalId === existing.ownerId
      ) {
        return {
          projectId: existing.id,
          principalLevel: input.principalLevel,
          principalId: input.principalId,
          effectiveRole: "owner" as ProjectRole,
          accessSource: "owner" as ProjectAccessSource,
        };
      }

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const result = await projectsDb.execute<{
        role: "read" | "write" | "admin";
      }>(sql`
        SELECT role
          FROM "${sql.raw(schema)}"."project_access"
         WHERE project_id = ${existing.id}
           AND principal_level = ${input.principalLevel}
           AND principal_id = ${input.principalId}
         LIMIT 1
      `);

      if (result.rows.length === 0) {
        return {
          projectId: existing.id,
          principalLevel: input.principalLevel,
          principalId: input.principalId,
          effectiveRole: null,
          accessSource: null,
        };
      }
      const row = result.rows[0]!;
      return {
        projectId: existing.id,
        principalLevel: input.principalLevel,
        principalId: input.principalId,
        effectiveRole: row.role as ProjectRole,
        accessSource: input.principalLevel as ProjectAccessSource,
      };
    },

    // -----------------------------------------------------------------------
    // project_agent_template_bindings_* primitives.
    //
    // Tool curation surface — pins agent templates to a project with a
    // visibility filter + optional pinned_version + per-project context
    // overrides. Templates stay ambient; the substrate table never gains
    // project_id. The CASCADE FK protects ref integrity when a template is
    // removed from the registry.
    // -----------------------------------------------------------------------

    "project_agent_template_bindings_create": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.projectAgentTemplateBindingsCreateSchema.parse(
        request.input,
      );
      assertAuthenticatedActor(request.actor);
      const { userId } = getActorExt(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'write'
      // (tool curation requires write).
      assertProjectGrantRole(request.actor, existing.id, "write");
      // Reject writes against an archived project. The role gate above already
      // implies the actor holds the grant; assertProjectWritable adds the
      // archive check
      // (idempotent w.r.t. role — the helper does NOT re-deny on
      // role insufficiency once assertProjectGrantRole has passed,
      // because the platform_admin bypass in assertProjectWritable also
      // covers the deduplication).
      await assertProjectWritable(
        request.actor as Parameters<typeof assertProjectWritable>[0],
        existing.id,
        "write",
      );

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const createdBy = userId ?? "system";
      const overridesJson =
        input.defaultContextOverrides == null
          ? null
          : JSON.stringify(input.defaultContextOverrides);

      await projectsDb.execute(sql`
        INSERT INTO "${sql.raw(schema)}"."project_agent_template_bindings"
          (project_id, agent_template_id, visibility, pinned_version,
           default_context_overrides, created_by)
        VALUES
          (${existing.id}, ${input.agentTemplateId}, ${input.visibility},
           ${input.pinnedVersion ?? null},
           ${overridesJson === null ? null : sql`${overridesJson}::jsonb`},
           ${createdBy})
        ON CONFLICT (project_id, agent_template_id) DO UPDATE
          SET visibility = EXCLUDED.visibility,
              pinned_version = EXCLUDED.pinned_version,
              default_context_overrides = EXCLUDED.default_context_overrides
      `);
      return { ok: true as const };
    },

    "project_agent_template_bindings_update": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.projectAgentTemplateBindingsUpdateSchema.parse(
        request.input,
      );
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'write'.
      assertProjectGrantRole(request.actor, existing.id, "write");
      // Archived projects reject binding mutations. The curation surface is
      // part of the project's first-class data; freezing it on archive is the
      // explicit doctrine.
      await assertProjectWritable(
        request.actor as Parameters<typeof assertProjectWritable>[0],
        existing.id,
        "write",
      );

      // Build a sparse UPDATE — only mutate the fields the caller provided.
      const setClauses: ReturnType<typeof sql>[] = [];
      if (input.visibility !== undefined) {
        setClauses.push(sql`visibility = ${input.visibility}`);
      }
      if (input.pinnedVersion !== undefined) {
        setClauses.push(sql`pinned_version = ${input.pinnedVersion}`);
      }
      if (input.defaultContextOverrides !== undefined) {
        const overridesJson =
          input.defaultContextOverrides == null
            ? null
            : JSON.stringify(input.defaultContextOverrides);
        setClauses.push(
          overridesJson === null
            ? sql`default_context_overrides = NULL`
            : sql`default_context_overrides = ${overridesJson}::jsonb`,
        );
      }
      if (setClauses.length === 0) return { ok: true as const };

      // sql.join with a comma separator builds a proper SET clause list.
      const setExpr = sql.join(setClauses, sql`, `);
      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      // `RETURNING 1` + 404 on zero affected rows so stale clients don't get a
      // silent success when the binding doesn't exist.
      const updateResult = await projectsDb.execute<{ ok: number }>(sql`
        UPDATE "${sql.raw(schema)}"."project_agent_template_bindings"
           SET ${setExpr}
         WHERE project_id = ${existing.id}
           AND agent_template_id = ${input.agentTemplateId}
        RETURNING 1 AS ok
      `);
      if (updateResult.rows.length === 0) {
        throw new AuthzError({
          statusCode: 404,
          reason: "hidden",
          message: "Binding not found",
        });
      }
      return { ok: true as const };
    },

    "project_agent_template_bindings_delete": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.projectAgentTemplateBindingsDeleteSchema.parse(
        request.input,
      );
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'write'.
      assertProjectGrantRole(request.actor, existing.id, "write");
      // Archived projects reject binding mutations. Removing a binding is a
      // mutation of the curated tool surface; the freeze is symmetric across
      // create/update/delete.
      await assertProjectWritable(
        request.actor as Parameters<typeof assertProjectWritable>[0],
        existing.id,
        "write",
      );

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      await projectsDb.execute(sql`
        DELETE FROM "${sql.raw(schema)}"."project_agent_template_bindings"
         WHERE project_id = ${existing.id}
           AND agent_template_id = ${input.agentTemplateId}
      `);
      return { ok: true as const };
    },

    "project_agent_template_bindings_list": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.projectAgentTemplateBindingsListSchema.parse(
        request.input,
      );
      assertAuthenticatedActor(request.actor);

      const existing = await readProjectById(input.projectId);
      if (!existing) {
        throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
      }

      // Gate on `actor.projectGrants` role 'read'.
      assertProjectGrantRole(request.actor, existing.id, "read");

      const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
      const result = await projectsDb.execute<{
        agent_template_id: string;
        visibility: "visible" | "hidden" | "project-private";
        pinned_version: string | null;
        default_context_overrides: Record<string, unknown> | null;
        created_by: string;
        created_at: Date;
      }>(sql`
        SELECT agent_template_id, visibility, pinned_version,
               default_context_overrides, created_by, created_at
          FROM "${sql.raw(schema)}"."project_agent_template_bindings"
         WHERE project_id = ${existing.id}
         ORDER BY agent_template_id
      `);

      const items = result.rows.map((r) => ({
        projectId: existing.id,
        agentTemplateId: r.agent_template_id,
        visibility: r.visibility,
        pinnedVersion: r.pinned_version,
        defaultContextOverrides: r.default_context_overrides,
        createdBy: r.created_by,
        createdAt: r.created_at,
      }));
      return { items };
    },
  } as const;
}

export const handlers = createProjectsPrimitiveHandlers();
