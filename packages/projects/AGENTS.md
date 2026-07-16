# packages/projects — AGENTS.md

Agent and developer guidance for the `@cinatra-ai/projects` package.

See also:
- root `AGENTS.md` → `## Scope Model` for the four-tier ownership rules and the canonical `ScopeBadge` component.
- `https://docs.cinatra.ai/references/platform/project-scoping/` — developer reference for the data model, authz axes, MCP surface, inheritance, sealed-room semantics, archive lifecycle, migration, and UI patterns. **Authoritative for anything project-scoping-related.**

## What this package does

Provides the `projects_*` and `project_access_*` and
`project_agent_template_bindings_*` MCP primitives. Every handler enforces
authz via `enforceResourceAccess` (kernel) PLUS `assertProjectGrantRole`
(N:M project access axis) so cross-org access is blocked uniformly and role
escalation requires the appropriate effective role.

The actual project rows live in `cinatra.projects` (Drizzle binding in
`src/lib/projects-store.ts`). The DAO at `src/lib/projects-store-dao.ts`
owns reads/writes; co-owners are stored in `cinatra.project_co_owners` and
accessed through `src/lib/project-co-owners-store.ts`. The N:M access rows
live in `cinatra.project_access`; bindings live in
`cinatra.project_agent_template_bindings`.

## Authorization rules

Two axes apply, in order:

1. **Kernel** — `enforceResourceAccess(envelope, actor, perm)` handles the
   four-tier ownership chain (user / team / organization / workspace),
   cross-org guard, owner-self-short-circuit, co-owner equivalence, and
   platform-admin bypass. This is the ownership axis.
2. **N:M project_access** — `assertProjectGrantRole(actor, projectId,
   required)` checks `actor.projectGrants[?].effectiveRole >= required`.
   Resolved by `readProjectGrantsForUser` (`@/lib/better-auth-db`) from
   three sources: implicit owned + explicit `project_access` rows +
   back-compat `project_co_owners`. Merged via `max-not-last-wins` so a
   more-permissive grant cannot be silently demoted.

Sealed-room read filtering and the substrate exclusion list live at the
data layer, not the resolver — see `https://docs.cinatra.ai/references/platform/project-scoping/` for the
full doctrine.

## Ownership model — no scope ratchet

Project is **never** an ownership tier. Ownership of the project row remains
at one of the four canonical levels (the `owner_level` column is unchanged),
but **access** to a project is N:M and granted through `project_access` rows.
The `assertScopeRatchet` helper and the `projects_delete` MCP primitive are
not part of the active surface; `updateProjectScopeAction` now throws on call
and is kept for type-checker regression protection.

## Scope ratchet — RETIRED

The `src/app/projects/scope-ratchet.ts` helper survives only so legacy
unit tests still import it; it is not on the MCP surface and is not called
from any RSC or server action.

## Key files

| File | Purpose |
|---|---|
| `src/mcp/handlers.ts` | All `projects_*`, `project_access_*`, `project_agent_template_bindings_*` handlers. Authz: `enforceResourceAccess` + `assertProjectGrantRole`. |
| `src/mcp/registry.ts` | MCP registry; stamps `actor.projectGrants` from session via `resolveActorRoleExtensionFromSession`. |
| `src/mcp/schemas.ts` | Zod schemas (strict). `ownerLevel`/`ownerId` are NOT on `projects_update`; there is no `projectsDeleteSchema`. |
| `src/index.ts` | Public surface — exports `handlers` (for in-process server-action wrappers) + `createProjectsModule` (for host wiring). |
| `src/integration/module.ts` | Host registration for the project primitives in the MCP runtime. |

## Permissions surface

`/projects/[projectId]/permissions` mirrors the canonical card layout:
Access section on top (`AccessCombobox`, retained for visual continuity but
now a no-op submitter), Ownership section middle (`ResourceOwnershipPanel`),
Project access section below (principal-level + role pickers, revoke per
row), single Save button at the bottom. The Project access section calls
`grantProjectAccessAction` / `revokeProjectAccessAction` /
`listProjectAccessAction` which forward to the MCP handlers in-process via
`@cinatra-ai/projects` exported `handlers`. Route-level guard is
`enforceResourceAccess('project.read')`; per-action mutations re-check via
`assertProjectGrantRole` inside the handlers.

## Bindings surface

`project_agent_template_bindings` pins an ambient agent template to a project
(the template itself stays ambient — substrate exclusion list) with a
visibility filter (visible / hidden / project-private), an optional
pinned_version, and optional default_context_overrides (JSON object). These
bindings are exposed only through the `project_agent_template_bindings_*` MCP
primitives (create / update / delete / list) below — the dedicated
`/projects/[projectId]/agents` route that used to manage them was removed in
the #707 projects-detail cleanup, but the kernel primitives are unchanged.

## Co-owners (legacy compatibility)

Co-owners get full equal rights to the original owner: `read`, `update`,
`manageMembers`, `share`. The only owner-only operation on a project is
`delete` (which is not on the MCP surface; archive is the lifecycle).
Adding a co-owner validates: (1) target user exists, (2) target user shares
the same org boundary as the project (cross-org additions are rejected),
(3) the request is idempotent (`ON CONFLICT DO NOTHING`). The co-owner
table is treated as a back-compat input to `readProjectGrantsForUser`
(Source 3 — every co-owner row maps to `{effectiveRole: "admin",
accessSource: "user"}`); new code SHOULD use `project_access_grant` with
`role='admin'` rather than touching `project_co_owners` directly.

## Actor context

Every handler receives a `PrimitiveActorContext` with `userId`,
`organizationId`, `roles`, `teamRoles`, AND **`projectGrants`** (the project
access axis). The canonical helper for converting a Better Auth session into
this shape is `actorFromSession()` in `@/lib/authz/build-actor-context`;
for handlers reached via MCP the registry stamps it via
`resolveActorRoleExtensionFromSession`. Anonymous actors (`userId: null`)
are rejected at the MCP boundary.

## Validation

```bash
pnpm typecheck                                           # fast (tsgo)
cd packages/projects && pnpm exec vitest run             # package tests
cd <repo-root> && pnpm exec vitest run \
  src/lib/__tests__/schema.test.ts \
  src/lib/__tests__/authz-project-grants.test.ts \
  src/lib/__tests__/sealed-room-inheritance.test.ts \
  src/lib/__tests__/resource-project-move.test.ts \
  src/lib/__tests__/sealed-room.test.ts \
  src/lib/__tests__/archive-lifecycle.test.ts
```
