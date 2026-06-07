// ---------------------------------------------------------------------------
// @cinatra-ai/projects - public surface.
//
// MCP primitives for cinatra.projects are gated through `enforceResourceAccess`
// so cross-tenant lookups are 404-hidden and co-owner / owner / admin rules are
// honored uniformly.
// ---------------------------------------------------------------------------

export { createProjectsPrimitiveHandlers, handlers } from "./mcp/handlers";
export { registerProjectsPrimitives } from "./mcp/registry";
export {
  projectsGetSchema,
  projectsListSchema,
  projectsCreateSchema,
  projectsUpdateSchema,
  // projectsDeleteSchema is intentionally not exported; deletion is handled by
  // the archive lifecycle.
  // project_access_* schemas.
  projectAccessGrantSchema,
  projectAccessRevokeSchema,
  projectAccessListSchema,
  projectAccessCheckSchema,
  // project_agent_template_bindings_* schemas.
  projectAgentTemplateBindingsCreateSchema,
  projectAgentTemplateBindingsUpdateSchema,
  projectAgentTemplateBindingsDeleteSchema,
  projectAgentTemplateBindingsListSchema,
} from "./mcp/schemas";
export { createProjectsModule } from "./integration/module";
