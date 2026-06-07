import { z } from "zod";

// ---------------------------------------------------------------------------
// @cinatra-ai/projects MCP schemas.
//
// Mirrors the objects schemas shape: each primitive owns a Zod schema that
// validates input at the registry layer before the handler is called.
// ---------------------------------------------------------------------------
//
// Includes project_access_* and project_agent_template_bindings_* schemas.
// projects_list supports includeArchived. There is no projects_delete primitive
// on the MCP surface; the lifecycle is archive-only.
// ---------------------------------------------------------------------------

const ownerLevelEnum = z.enum(["user", "team", "organization", "workspace"]);
const visibilityEnum = z.enum(["private", "discoverable"]);

// project_access principal levels mirror the CHECK constraint on
// cinatra.project_access (`principal_level IN
// ('user','team','organization','workspace')`). The workspace principal
// must use the reserved sentinel `__workspace__` for principal_id (also
// enforced by the DB CHECK `project_access_workspace_principal_chk`).
const principalLevelEnum = z.enum(["user", "team", "organization", "workspace"]);
const accessRoleEnum = z.enum(["read", "write", "admin"]);

// project_agent_template_bindings.visibility — DB CHECK constraint
// `visibility IN ('visible','hidden','project-private')`.
const bindingVisibilityEnum = z.enum(["visible", "hidden", "project-private"]);

export const projectsGetSchema = z.object({
  projectId: z.string().min(1),
});

export const projectsListSchema = z.object({
  ownerLevel: ownerLevelEnum.optional(),
  ownerId: z.string().optional(),
  // Default `archived=false`. Set to true to include rows where
  // `archived_at IS NOT NULL`.
  includeArchived: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const projectsCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  ownerLevel: ownerLevelEnum,
  ownerId: z.string().min(1),
  visibility: visibilityEnum.optional().default("private"),
});

// Ownership changes (ownerLevel/ownerId) are intentionally NOT supported by
// projects_update — callers must go through the dedicated
// `updateProjectScopeAction` server action which runs the ratchet check.
// We use `.strict()` so passing those fields is a hard schema error
// rather than a silently-dropped field — without it, a client could
// receive `{ok: true}` and wrongly assume the change persisted.
export const projectsUpdateSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    visibility: visibilityEnum.optional(),
  })
  .strict();

// projects_delete is intentionally absent from the MCP surface. The DAO helper
// `deleteProject` is kept for server actions (`deleteProjectAction` /
// `deleteProjectAsPlatformAdmin`); do NOT add `projectsDeleteSchema` back.

// ---------------------------------------------------------------------------
// Archive lifecycle schemas.
//
// Both primitives take a single projectId; admin/owner authz is enforced
// in the handler via assertProjectGrantRole(... "admin"). SQL is
// idempotent (archive on already-archived = no-op return; unarchive on
// active = no-op return).
// ---------------------------------------------------------------------------

export const projectsArchiveSchema = z
  .object({
    projectId: z.string().min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const projectsUnarchiveSchema = z
  .object({
    projectId: z.string().min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// project_access_* schemas
// ---------------------------------------------------------------------------

export const projectAccessGrantSchema = z
  .object({
    projectId: z.string().min(1),
    principalLevel: principalLevelEnum,
    principalId: z.string().min(1),
    role: accessRoleEnum,
  })
  .strict();

export const projectAccessRevokeSchema = z
  .object({
    projectId: z.string().min(1),
    principalLevel: principalLevelEnum,
    principalId: z.string().min(1),
  })
  .strict();

export const projectAccessListSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

export const projectAccessCheckSchema = z
  .object({
    projectId: z.string().min(1),
    principalLevel: principalLevelEnum,
    principalId: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// project_agent_template_bindings_* schemas
// ---------------------------------------------------------------------------

export const projectAgentTemplateBindingsCreateSchema = z
  .object({
    projectId: z.string().min(1),
    agentTemplateId: z.string().min(1),
    visibility: bindingVisibilityEnum.optional().default("visible"),
    pinnedVersion: z.string().min(1).nullable().optional(),
    // default_context_overrides column CHECK enforces jsonb_typeof =
    // 'object'; mirror that here so callers can't pass arrays/scalars.
    // `z.record(z.string(), z.unknown())` rejects non-objects at the
    // boundary before the SQL CHECK ever fires.
    defaultContextOverrides: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .strict();

export const projectAgentTemplateBindingsUpdateSchema = z
  .object({
    projectId: z.string().min(1),
    agentTemplateId: z.string().min(1),
    visibility: bindingVisibilityEnum.optional(),
    pinnedVersion: z.string().min(1).nullable().optional(),
    defaultContextOverrides: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .strict();

export const projectAgentTemplateBindingsDeleteSchema = z
  .object({
    projectId: z.string().min(1),
    agentTemplateId: z.string().min(1),
  })
  .strict();

export const projectAgentTemplateBindingsListSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();
