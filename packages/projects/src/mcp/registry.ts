import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  readTeamsForUser,
  readProjectGrantsForUser,
  type ProjectGrant,
} from "@/lib/better-auth-db";
import { createProjectsPrimitiveHandlers } from "./handlers";
import * as schemas from "./schemas";

// Resolve role hints from the Better Auth session so the kernel
// receives `platformRole` / `teamIds` / `projectIds` rather than the
// bare `{userId, orgId}` envelope. Mirrors
// `resolveRoleHintsFromSession` in agent-builder. Returns a partial
// actor extension (`roles[]`, `teamRoles{}`) the registry merges into
// the synthesized actor so `enforceResourceAccess.deriveRoleHints` can
// see them. Failures fall back to undefined — the kernel then applies
// its baseline rules (member-tier deny by default).
async function resolveActorRoleExtensionFromSession(): Promise<{
  roles?: string[];
  teamIds?: string[];
  projectIds?: string[];
  projectGrants?: ProjectGrant[];
} | undefined> {
  try {
    const session = await getAuthSession();
    if (!session) return undefined;
    const userId = session.user?.id ?? null;
    const orgId = session.session?.activeOrganizationId ?? null;
    const platformAdmin = isPlatformAdmin(session);
    // Route through the canonical resolver. teamRoles is unavailable
    // from public."teamMember" (no role column); the resolver degrades
    // team-owned implicit grants to {read, team} — safe.
    const teamIds = userId && orgId
      ? (await readTeamsForUser(userId, orgId)).map((t) => t.id)
      : [];
    const projectGrants = userId && orgId
      ? await readProjectGrantsForUser(userId, orgId, { teamIds })
      : [];
    const roles: string[] = [];
    if (platformAdmin) roles.push("platform_admin");
    // Merge per-scope role grants from the role_grant store. Resolver
    // returns distinct role names; scope-narrowing is the per-resource
    // resolver's responsibility.
    if (userId && orgId) {
      try {
        const { resolveEffectiveRoleNamesForUser } = await import("@/lib/authz/role-grant-store");
        const extra = await resolveEffectiveRoleNamesForUser(userId, orgId);
        for (const r of extra) {
          if (!roles.includes(r)) roles.push(r);
        }
      } catch {
        // role_grant table may not exist on legacy schemas — fall through.
      }
    }
    return {
      roles,
      teamIds,
      // Keep projectIds for back-compat consumers that still read the
      // binary id list (auth-policy.ts :198 / :490-491 shortcuts).
      projectIds: projectGrants.map((g) => g.projectId),
      projectGrants,
    };
  } catch {
    return undefined;
  }
}

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  projects_get: {
    description: "Fetch a project by id (404-hidden when caller cannot read it).",
    inputSchema: schemas.projectsGetSchema,
  },
  projects_list: {
    description:
      "List projects visible to the actor (owned ∪ accessed) with effectiveRole/accessSource per row. Default archived=false; pass includeArchived=true to include archived rows.",
    inputSchema: schemas.projectsListSchema,
  },
  projects_create: {
    description: "Create a project. Caller must hold project.create at the requested ownerLevel.",
    inputSchema: schemas.projectsCreateSchema,
  },
  projects_update: {
    description: "Update a project's mutable fields (name, description, visibility).",
    inputSchema: schemas.projectsUpdateSchema,
  },
  // projects_delete is intentionally absent. Archive lifecycle is exposed
  // through projects_archive / projects_unarchive.

  // Archive lifecycle primitives.
  projects_archive: {
    description:
      "Archive a project. Idempotent — re-archiving an already-archived project returns { alreadyArchived: true }. Admin/owner authz required. Archived projects reject every new write (inherited writes, moves into archived projects, and binding mutations) via assertProjectWritable; they remain readable for grant-holders and the project can still be moved OUT of (or unarchived).",
    inputSchema: schemas.projectsArchiveSchema,
  },
  projects_unarchive: {
    description:
      "Unarchive a project. Idempotent — re-activating an already-active project returns { alreadyActive: true }. Admin/owner authz required.",
    inputSchema: schemas.projectsUnarchiveSchema,
  },

  // project_access_* primitives.
  project_access_grant: {
    description:
      "Grant a principal (user/team/organization/workspace) a role (read/write/admin) on a project. Idempotent — re-granting the same principal updates the role. Owner self-insert rejected; admin-role grants are owner-only.",
    inputSchema: schemas.projectAccessGrantSchema,
  },
  project_access_revoke: {
    description:
      "Revoke a principal's role on a project. No-op if the principal had no row.",
    inputSchema: schemas.projectAccessRevokeSchema,
  },
  project_access_list: {
    description:
      "List effective access rows for a project, including the derived owner row (computed from projects.owner_level/owner_id — never stored).",
    inputSchema: schemas.projectAccessListSchema,
  },
  project_access_check: {
    description:
      "Return the effective role for the queried principal on a project (or null if none).",
    inputSchema: schemas.projectAccessCheckSchema,
  },

  // project_agent_template_bindings_* primitives.
  project_agent_template_bindings_create: {
    description:
      "Pin an agent template to a project with a visibility filter and optional pinned_version + per-project default context overrides. Idempotent — re-create updates the existing row.",
    inputSchema: schemas.projectAgentTemplateBindingsCreateSchema,
  },
  project_agent_template_bindings_update: {
    description:
      "Update a binding's mutable fields (visibility, pinned_version, default_context_overrides).",
    inputSchema: schemas.projectAgentTemplateBindingsUpdateSchema,
  },
  project_agent_template_bindings_delete: {
    description:
      "Remove a binding. The agent template itself stays ambient; the substrate table never gains project_id.",
    inputSchema: schemas.projectAgentTemplateBindingsDeleteSchema,
  },
  project_agent_template_bindings_list: {
    description: "List all agent-template bindings curated for a project.",
    inputSchema: schemas.projectAgentTemplateBindingsListSchema,
  },
};

export function registerProjectsPrimitives(server: McpRuntimeToolServer) {
  const handlers = createProjectsPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? {
      description: name,
      inputSchema: z.object({}).passthrough(),
    };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        const requestCtx = mcpRequestContextStorage.getStore();
        const orgId = requestCtx?.orgId ?? null;
        const userId = requestCtx?.userId ?? null;

        // Propagate platformRole from the MCP request context. The
        // session-derived `roleExt.roles` lookup below also surfaces
        // 'platform_admin', but transport-stamped `platformRole` is the
        // canonical (cheaper, no DB round-trip) signal — match the
        // pattern in objects / lists / dashboards.
        const platformRole = requestCtx?.platformRole;
        const actorBase: Record<string, unknown> = {
          actorType: platformRole ? "human" : "model",
          source: "agent",
        };
        if (userId) actorBase.userId = userId;
        if (orgId) {
          actorBase.orgId = orgId;
          // Mirror `organizationId` so `deriveRoleHints` can pick it up
          // through either field name.
          actorBase.organizationId = orgId;
        }
        if (platformRole) actorBase.platformRole = platformRole;

        // Forward Better Auth role hints (platform admin flag,
        // team/project membership) into the actor envelope.
        const roleExt = await resolveActorRoleExtensionFromSession();
        if (roleExt?.roles && roleExt.roles.length > 0) actorBase.roles = roleExt.roles;
        if (roleExt?.teamIds && roleExt.teamIds.length > 0) actorBase.teamIds = roleExt.teamIds;
        if (roleExt?.projectIds && roleExt.projectIds.length > 0) actorBase.projectIds = roleExt.projectIds;
        // Propagate the canonical project-grant axis alongside the
        // binary projectIds so downstream consumers
        // (buildActorContextFromPrimitive) see grants and derive the
        // single-source-of-truth projectIds in-kernel.
        if (roleExt?.projectGrants) actorBase.projectGrants = roleExt.projectGrants;

        const result = await handler({
          primitiveName: name,
          input,
          actor: actorBase as unknown as Parameters<typeof handler>[0]["actor"],
          mode: "agentic",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent:
            Array.isArray(result)
              ? { items: result }
              : typeof result === "object" && result !== null
                ? (result as Record<string, unknown>)
                : { result },
        };
      }) as any,
    );
  }
}
