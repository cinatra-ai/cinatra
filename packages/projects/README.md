# @cinatra-ai/projects

MCP primitives for projects — bounded execution and context spaces that own
agents, objects, and runs. Handlers enforce four-tier ownership (user / team /
organization / workspace) plus an N:M project-access axis, so cross-tenant
lookups are 404-hidden and role escalation requires the appropriate effective
role.

## Public API

- `createProjectsModule` — host wiring (`registerCapabilities`) for the MCP runtime.
- `registerProjectsPrimitives(server)` — registers all primitives on an `McpRuntimeToolServer`.
- `createProjectsPrimitiveHandlers` — builds the keyed primitive handlers.
- `handlers` — the handler map, for in-process server-action wrappers.

Zod input schemas (one per primitive):

- `projectsGetSchema`, `projectsListSchema`, `projectsCreateSchema`, `projectsUpdateSchema` — project CRUD (no delete; archive is the lifecycle).
- `projectAccessGrantSchema`, `projectAccessRevokeSchema`, `projectAccessListSchema`, `projectAccessCheckSchema` — N:M access grants per principal.
- `projectAgentTemplateBindingsCreateSchema`, `projectAgentTemplateBindingsUpdateSchema`, `projectAgentTemplateBindingsDeleteSchema`, `projectAgentTemplateBindingsListSchema` — pin agent templates to a project.

The registered primitive names are `projects_*`, `project_access_*`, and
`project_agent_template_bindings_*`.

## Usage

```ts
import { createProjectsModule } from "@cinatra-ai/projects";

const projectsModule = createProjectsModule();
projectsModule.registerCapabilities(server); // server: McpRuntimeToolServer
```

## Docs

See https://docs.cinatra.ai
