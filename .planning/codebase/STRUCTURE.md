# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
cinatra/                              # Repo root
├── src/                              # Next.js application source
│   ├── app/                          # App Router: pages, layouts, Server Actions, API routes
│   │   ├── api/                      # Route handlers (chat, mcp, a2a, llm-bridge, etc.)
│   │   ├── agents/                   # Agents feature pages
│   │   ├── artifacts/                # Artifacts library pages
│   │   ├── campaigns/                # Campaign management pages
│   │   ├── chat/                     # Chat UI pages
│   │   ├── connectors/               # Connector settings pages
│   │   ├── dashboards/               # Dashboards pages
│   │   ├── data/                     # Data objects pages
│   │   ├── design-fixtures/          # Internal design fixture pages (non-production)
│   │   ├── notifications/            # Notifications pages
│   │   ├── projects/                 # Projects pages
│   │   ├── skills/                   # Skills pages
│   │   ├── workflows/                # Workflows pages
│   │   ├── layout.tsx                # Root layout — auth gate, setup wizard, nav permissions
│   │   ├── page.tsx                  # Root page
│   │   ├── providers.tsx             # React context providers (client)
│   │   ├── plugins-registry.tsx      # Plugin/extension UI registry
│   │   └── globals.css               # Global styles
│   ├── components/                   # Shared React components
│   │   ├── ui/                       # Low-level shadcn/Radix UI primitives
│   │   ├── reui/                     # Re-exported UI primitives
│   │   ├── layout/                   # Layout components (app shell, sidebar, nav)
│   │   ├── dashboards/               # Dashboard-specific components
│   │   │   └── portlets/             # Dashboard portlet components
│   │   ├── extensions/               # Extension management UI components
│   │   ├── workflows/                # Workflow UI components
│   │   ├── widgets/                  # Widget components (blog, etc.)
│   │   ├── data-safety/              # Data-safety info components
│   │   ├── data-table/               # Data table component
│   │   └── app-shell.tsx             # Top-level app shell wrapper
│   ├── lib/                          # Host library — business logic, DB, auth, DI wiring
│   │   ├── authz/                    # RBAC kernel: actor context, policies, enforce, audit
│   │   │   ├── __generated__/        # Generated authz inventory files
│   │   │   └── actor-context.ts      # ActorContext discriminated union types
│   │   ├── artifacts/                # Artifact storage, context MCP, attachment resolver
│   │   ├── blog/                     # Blog feature: application, integration, MCP, ports
│   │   ├── dashboards/               # Dashboard store helpers
│   │   ├── external-mcp/             # External MCP client/server settings
│   │   ├── generated/                # Generated DB schema / Drizzle types
│   │   ├── instance-namespace/       # Instance namespace helpers
│   │   ├── notifications/            # Notification persistence
│   │   ├── object-history/           # Object history + freshness tracking
│   │   │   ├── __generated__/        # Generated types
│   │   │   └── freshness/            # Freshness check logic
│   │   ├── objects/                  # Object-type registration, dual-write helpers
│   │   ├── auth.ts                   # Better Auth config + OAuth
│   │   ├── auth-session.ts           # Session resolution helpers, requireActorContext()
│   │   ├── database.ts               # Postgres / Drizzle client
│   │   ├── drizzle-store.ts          # Drizzle query builders
│   │   ├── extensions.ts             # ExtensionRegistry + lifecycle hook wiring
│   │   ├── mcp-server.ts             # MCP server module assembly
│   │   ├── background-jobs.ts        # BullMQ queue definitions
│   │   └── ...                       # ~200 additional service/store files
│   ├── context/                      # React context definitions
│   ├── hooks/                        # Custom React hooks
│   ├── types/                        # Shared TypeScript type definitions
│   ├── instrumentation.ts            # Next.js instrumentation entry point (edge + node shim)
│   └── instrumentation.node.ts       # Node.js-only boot: DI wiring, Sentry, OTEL, transports
├── packages/                         # pnpm workspace internal packages (@cinatra-ai/*)
│   ├── a2a/                          # @cinatra-ai/a2a — Agent-to-Agent JSON-RPC + SSE protocol
│   ├── agent-ui-protocol/            # @cinatra-ai/agent-ui-protocol — AG-UI event streaming
│   ├── agents/                       # @cinatra-ai/agents — agent authoring, MCP modules, CLI
│   ├── artifacts/                    # @cinatra-ai/artifacts — artifact type definitions
│   ├── chat/                         # @cinatra-ai/chat — chat thread persistence, MCP module
│   ├── cli/                          # @cinatra-ai/cli — admin CLI tooling
│   ├── connectors/                   # @cinatra-ai/connectors — connector base types
│   ├── connectors-catalog/           # @cinatra-ai/connectors-catalog — connector catalog
│   ├── dashboards/                   # @cinatra-ai/dashboards — dashboard engine (drizzle-cube)
│   ├── design/                       # @cinatra-ai/design — design system tokens, components
│   ├── errors/                       # @cinatra-ai/errors — shared error types
│   ├── extension-types/              # @cinatra-ai/extension-types — extension manifest types
│   ├── extensions/                   # @cinatra-ai/extensions — extension lifecycle engine
│   ├── google-oauth-connection/      # @cinatra-ai/google-oauth-connection — Google OAuth integration
│   ├── llm/                          # @cinatra-ai/llm — unified LLM orchestration, adapters
│   ├── marketplace-application-reconcile/ # @cinatra-ai/marketplace-application-reconcile
│   ├── marketplace-mcp-client/       # @cinatra-ai/marketplace-mcp-client
│   ├── marketplace-sync/             # @cinatra-ai/marketplace-sync — marketplace catalog sync
│   ├── mcp-client/                   # @cinatra-ai/mcp-client — MCP client utilities
│   ├── mcp-server/                   # @cinatra-ai/mcp-server — MCP server SDK (auth, mount)
│   ├── metric-cost-api/              # @cinatra-ai/metric-cost-api — cost metrics
│   ├── metric-usage-api/             # @cinatra-ai/metric-usage-api — usage metrics
│   ├── notifications/                # @cinatra-ai/notifications — notification types
│   ├── objects/                      # @cinatra-ai/objects — object-type registry, sync adapters
│   ├── permissions/                  # @cinatra-ai/permissions — permissions MCP module
│   ├── projects/                     # @cinatra-ai/projects — project store, MCP module
│   ├── registries/                   # @cinatra-ai/registries — registry client helpers
│   ├── sdk-dashboard/                # @cinatra-ai/sdk-dashboard — dashboard SDK types
│   ├── sdk-extensions/               # @cinatra-ai/sdk-extensions — extension SDK (DI slots)
│   ├── sdk-ui/                       # @cinatra-ai/sdk-ui — UI SDK primitives for extensions
│   ├── skills/                       # @cinatra-ai/skills — skills engine, MCP module
│   ├── trigger/                      # @cinatra-ai/trigger — event trigger system
│   ├── trigger-email-send/           # @cinatra-ai/trigger-email-send — email trigger
│   └── workflows/                    # @cinatra-ai/workflows — workflow engine + install saga
├── extensions/                       # Runtime-loadable extension packages (not in repo — loaded from verdaccio)
│   └── cinatra-ai/                   # Cinatra-authored extensions (*-connector, *-artifact, *-workflow)
├── contracts/                        # API contract fixtures for integration testing
│   └── wp-drupal-assistant/v1/       # WordPress/Drupal assistant contract
├── docker/                           # Docker service configs
│   ├── drupal/                       # Drupal test instance
│   ├── verdaccio/                    # Private npm registry for extension packages
│   ├── wayflow/                      # Wayflow agent runner + test configs
│   └── wordpress/                    # WordPress test instance
├── docs/                             # Developer documentation
├── scripts/                          # Dev/CI utility scripts
│   ├── ci/                           # CI-specific scripts
│   ├── extensions/                   # Extension scaffolding scripts
│   ├── design/                       # Design system scripts
│   └── fixtures/                     # Fixture generation scripts
├── tests/                            # Test suites outside src/
│   ├── contracts/                    # Contract tests (wp-drupal)
│   ├── e2e/                          # Playwright end-to-end tests
│   │   ├── agents-run/               # Agent run e2e
│   │   ├── dashboards/               # Dashboard e2e
│   │   ├── notifications/            # Notifications e2e
│   │   ├── rbac/                     # RBAC e2e
│   │   ├── render-smoke/             # Visual regression smoke tests
│   │   ├── workflows/                # Workflow e2e
│   │   └── wp-drupal-uat/            # WordPress/Drupal UAT
│   └── __stubs__/                    # Shared test stubs
├── public/                           # Next.js static assets
├── next.config.ts                    # Next.js configuration (standalone output, OTEL, rewrites)
├── tsconfig.json                     # TypeScript config (strict, path aliases)
├── vitest.config.ts                  # Vitest unit test config
├── eslint.config.mjs                 # ESLint flat config
├── pnpm-workspace.yaml               # pnpm workspace package globs + overrides
├── docker-compose.yml                # Full stack (Postgres, Redis, Verdaccio, Wayflow, etc.)
├── docker-compose.dev.yml            # Dev override (port overrides, volume mounts)
├── Makefile                          # Common dev commands
├── Dockerfile                        # Production container build (standalone Next.js)
├── AGENTS.md                         # AI agent guidance for this repo
└── components.json                   # shadcn/ui component registry config
```

## Directory Purposes

**`src/app/`:**
- Purpose: All Next.js App Router routes — pages, layouts, Server Actions, and API route handlers
- Contains: RSC page components (`page.tsx`), layout files (`layout.tsx`), `actions.ts` Server Action files, `src/app/api/` HTTP endpoints
- Key files: `src/app/layout.tsx` (root layout), `src/app/providers.tsx` (client providers), `src/app/api/chat/route.ts`, `src/app/api/mcp/route.ts`, `src/app/api/a2a/route.ts`

**`src/lib/`:**
- Purpose: Host library — all server-side business logic, DB access, auth, DI wiring, extension orchestration
- Contains: ~200 TypeScript modules covering auth, authz, extension lifecycle, MCP assembly, background jobs, Drizzle store, connector registrations
- Key files: `src/lib/auth.ts`, `src/lib/auth-session.ts`, `src/lib/database.ts`, `src/lib/extensions.ts`, `src/lib/mcp-server.ts`, `src/lib/authz/enforce.ts`

**`src/lib/authz/`:**
- Purpose: RBAC enforcement kernel
- Contains: `ActorContext` types, policy definitions, `enforce.ts` (capability check), `audit.ts`, scope maps, role-grant stores
- Key files: `src/lib/authz/actor-context.ts`, `src/lib/authz/enforce.ts`, `src/lib/authz/policies.ts`, `src/lib/authz/build-actor-context.ts`

**`src/components/`:**
- Purpose: Shared React components used across multiple app routes
- Contains: UI primitives (`ui/`, `reui/`), layout shell (`layout/`, `app-shell.tsx`), domain-specific shared components
- Key files: `src/components/app-shell.tsx`, `src/components/app-sidebar.tsx`

**`packages/`:**
- Purpose: Internal pnpm workspace packages — independently scoped domain libraries
- Contains: 35 packages covering LLM, agents, chat, workflows, extensions, MCP, objects, skills, metrics, design, SDK contracts
- Key files: `packages/llm/src/index.ts`, `packages/agents/src/index.ts`, `packages/extensions/src/`, `packages/mcp-server/src/`

**`tests/e2e/`:**
- Purpose: Playwright end-to-end test suites
- Contains: Feature-specific test directories with `.auth/` storage state, fixtures, config
- Key files: `tests/e2e/config/`, `tests/e2e/agents-run/`, `tests/e2e/rbac/`

**`docker/`:**
- Purpose: Docker service configurations for local dev and CI
- Contains: Verdaccio (private npm registry), Wayflow (agent runner), WordPress/Drupal test stacks
- Note: `docker/verdaccio/` is critical for extension package publishing during dev

**`scripts/`:**
- Purpose: Dev/CI utility scripts (schema checks, auth migrations, fixture seeding, extension scaffolding)
- Contains: `.mjs`/`.mts` scripts; `scripts/ci/` for pipeline-specific utilities

## Key File Locations

**Entry Points:**
- `src/instrumentation.node.ts`: Node.js boot — DI wiring, Sentry/OTEL init, transport connector registration
- `src/app/layout.tsx`: Root RSC layout — auth gate, setup wizard, nav resolution
- `src/app/page.tsx`: Root page component

**API Routes:**
- `src/app/api/chat/route.ts`: Chat SSE stream endpoint
- `src/app/api/chat/runner.ts`: Core `runChatTurn()` logic with LLM tool assembly
- `src/app/api/mcp/route.ts`: MCP JSON-RPC server endpoint
- `src/app/api/a2a/route.ts`: A2A agent protocol endpoint
- `src/app/api/llm-bridge/route.ts`: LLM proxy bridge

**Authorization:**
- `src/lib/authz/actor-context.ts`: `ActorContext` type definitions
- `src/lib/authz/enforce.ts`: Capability enforcement entry point
- `src/lib/authz/policies.ts`: Policy definitions
- `src/lib/auth-session.ts`: `getAuthSession()`, `requireActorContext()`, `requireAuthSession()`
- `src/lib/auth.ts`: Better Auth instance configuration

**Database:**
- `src/lib/database.ts`: Drizzle + Postgres connection pool
- `src/lib/drizzle-store.ts`: Reusable Drizzle query builders
- `src/lib/better-auth-db.ts`: Better Auth DB helpers (users, sessions, memberships)
- `src/lib/generated/`: Generated Drizzle schema types

**Extension System:**
- `src/lib/extensions.ts`: ExtensionRegistry setup + lifecycle hook wiring
- `src/lib/extension-install-pipeline.ts`: Extension install orchestration
- `src/lib/extension-signature.ts`: Package signature verification
- `src/lib/mcp-server.ts`: Full MCP module assembly (imports all connector/domain modules)
- `src/lib/extension-activate-hook-wiring.ts`: Hot-activate hook side-effect registration

**Configuration:**
- `next.config.ts`: Next.js config (standalone, env validation, OTEL, allowed origins)
- `tsconfig.json`: TypeScript config (path aliases: `@/*` → `src/*`, `@cinatra-ai/*` → `packages/*/src/`)
- `vitest.config.ts`: Vitest unit test config
- `pnpm-workspace.yaml`: Workspace package globs + dependency overrides
- `.env.example`: Reference for required environment variables

**Testing:**
- `vitest.config.ts`: Vitest config for unit/integration tests
- `tests/e2e/`: Playwright e2e suites
- `src/**/__tests__/`: Co-located unit tests (per package and `src/lib/`)
- `packages/*/tests/`: Package-level integration/stub tests

## Naming Conventions

**Files:**
- Kebab-case for all TypeScript files: `agent-run-context-registry.ts`, `extension-install-pipeline.ts`
- `.tsx` suffix for files containing JSX; `.ts` for pure TypeScript
- `route.ts` for App Router API endpoints
- `page.tsx` for App Router page components
- `layout.tsx` for App Router layout components
- `actions.ts` for Server Action files
- `module.ts` for MCP module factories (`packages/*/src/integration/module.ts`)
- `__tests__/` subdirectory for co-located unit tests
- `__stubs__/` for test stub data
- `__fixtures__/` for test fixture data
- `__generated__/` for generated files (authz inventory, DB types)

**Directories:**
- Kebab-case: `object-history/`, `instance-namespace/`, `external-mcp/`
- Feature-named in `src/app/`: `agents/`, `workflows/`, `dashboards/`, `connectors/`
- Package names under `packages/` match `@cinatra-ai/<package-name>`

**Functions:**
- `create*Module()` — MCP module factory functions
- `build*()` — Builder functions that assemble complex objects
- `register*()` — Side-effect registration functions
- `require*()` — Functions that throw if a required resource/session is absent
- `get*()` — Async data-fetch functions
- `resolve*()` — Resolution/lookup functions

## Where to Add New Code

**New App Route (page):**
- Primary code: `src/app/<feature>/page.tsx`
- Layout (if needed): `src/app/<feature>/layout.tsx`
- Server Actions: `src/app/<feature>/actions.ts`
- Tests: `src/app/<feature>/__tests__/`

**New API Endpoint:**
- Primary code: `src/app/api/<endpoint>/route.ts`
- Follow Zod validation pattern from `src/app/api/chat/route.ts`
- Resolve `ActorContext` via `requireActorContext()` from `src/lib/auth-session.ts`

**New Business Logic / DB Store:**
- Implementation: `src/lib/<feature>-store.ts` or `src/lib/<feature>.ts`
- Tests: `src/lib/__tests__/<feature>.test.ts`

**New Shared UI Component:**
- Implementation: `src/components/<component-name>.tsx`
- Tests: `src/components/__tests__/<component-name>.test.tsx`

**New Internal Package:**
- Implementation: `packages/<package-name>/src/`
- Register in `pnpm-workspace.yaml` is automatic (already covered by `packages/*`)
- Add `package.json` with `"name": "@cinatra-ai/<package-name>"`

**New MCP Module (domain tools for LLM):**
- Factory: `packages/<domain>/src/integration/module.ts` following `create*Module()` pattern
- Register in: `src/lib/mcp-server.ts` (import and add to module list)

**New Connector Extension:**
- Location: `extensions/<vendor>/<slug>-connector/`
- Must follow `@cinatra-ai/sdk-extensions` contract; registered via `pnpm-workspace.yaml` pattern `extensions/*/*-connector`
- MCP module: `extensions/<vendor>/<slug>-connector/src/mcp-module.ts`

**New Authz Policy:**
- Add to: `src/lib/authz/policies.ts`
- Update scope map: `src/lib/authz/scope-map.ts`
- Regenerate inventory: run `scripts/build-authz-inventory.mjs`

**New e2e Test:**
- Location: `tests/e2e/<feature>/`
- Auth storage state: `tests/e2e/<feature>/.auth/`

## Special Directories

**`.planning/`:**
- Purpose: GSD planning documents (phases, codebase maps)
- Generated: No (human/AI-authored)
- Committed: Yes (see `.planning/ folder allowed` memory note)

**`src/lib/generated/`:**
- Purpose: Generated Drizzle ORM schema types
- Generated: Yes (by Drizzle codegen / `scripts/`)
- Committed: Yes

**`src/lib/authz/__generated__/`:**
- Purpose: Generated authz inventory (write-surface and policy inventory)
- Generated: Yes (by `scripts/build-authz-inventory.mjs`)
- Committed: Yes

**`src/lib/object-history/__generated__/`:**
- Purpose: Generated object history types
- Generated: Yes
- Committed: Yes

**`.next/`:**
- Purpose: Next.js build output
- Generated: Yes
- Committed: No

**`node_modules/`:**
- Purpose: Installed npm dependencies
- Generated: Yes (pnpm install)
- Committed: No

---

*Structure analysis: 2026-06-09*
