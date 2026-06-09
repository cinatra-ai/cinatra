<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                    Next.js 15 App Router (SSR / RSC)                     │
│  src/app/  — pages, layouts, Server Actions, API route handlers          │
├──────────────────┬───────────────────┬──────────────────────────────────┤
│  UI Components   │  API Routes        │  Instrumentation / Boot          │
│  src/components/ │  src/app/api/      │  src/instrumentation.ts          │
│  packages/design │  /chat /mcp /a2a   │  src/instrumentation.node.ts     │
│  packages/sdk-ui │  /llm-bridge       │  (DI wiring, crash handlers)     │
└────────┬─────────┴────────┬──────────┴──────────────┬───────────────────┘
         │                  │                          │
         ▼                  ▼                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Host Library Layer (src/lib/)                    │
│  auth.ts / auth-session.ts — Better Auth + session                      │
│  authz/ — RBAC enforcement (actor context, policies, enforce.ts)        │
│  extensions.ts — ExtensionRegistry + lifecycle hooks                    │
│  mcp-server.ts — MCP module assembly + auth                             │
│  database.ts / drizzle-store.ts — Postgres via Drizzle ORM              │
└────────┬─────────────────────────────────────────────────────────────┬─┘
         │                                                             │
         ▼                                                             ▼
┌────────────────────────────────┐  ┌────────────────────────────────────┐
│   Internal Packages            │  │  Extension Packages (runtime)       │
│   packages/llm       — LLM     │  │  extensions/cinatra-ai/*-connector  │
│   packages/agents    — agents  │  │  extensions/cinatra-ai/*-artifact   │
│   packages/chat      — chat    │  │  extensions/cinatra-ai/*-workflow   │
│   packages/workflows — flows   │  │  extensions/*/*-connector           │
│   packages/mcp-server— MCP SDK │  │  (loaded by ExtensionRegistry at   │
│   packages/objects   — objects │  │   runtime via extension-package-    │
│   packages/skills    — skills  │  │   store / verdaccio)                │
│   packages/a2a       — A2A     │  └────────────────────────────────────┘
│   packages/extensions— host SDK│
│   packages/sdk-extensions      │
│   ...35 total packages         │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│   External Storage & Services                                           │
│   Postgres (Supabase)  —  src/lib/database.ts, src/lib/drizzle-store.ts│
│   Redis (BullMQ)       —  src/lib/background-jobs.ts                   │
│   Verdaccio registry   —  docker/verdaccio/, src/lib/verdaccio-config.ts│
│   OpenTelemetry/Sentry —  src/lib/otel-bootstrap.ts, sentry.*.config.ts│
└────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | Key Files |
|-----------|----------------|-----------|
| Next.js App Router | SSR pages, layouts, Server Actions, route guards | `src/app/layout.tsx`, `src/app/page.tsx` |
| API Routes | HTTP endpoints for chat SSE, MCP, A2A, LLM bridge | `src/app/api/chat/route.ts`, `src/app/api/mcp/route.ts`, `src/app/api/a2a/route.ts` |
| Host Library (`src/lib/`) | Business logic, DB access, auth, DI wiring | `src/lib/auth.ts`, `src/lib/mcp-server.ts`, `src/lib/extensions.ts` |
| Authz Kernel | RBAC policy enforcement, ActorContext, scopes | `src/lib/authz/enforce.ts`, `src/lib/authz/actor-context.ts` |
| `@cinatra-ai/llm` | Unified LLM orchestration, provider adapters, streaming | `packages/llm/src/index.ts` |
| `@cinatra-ai/agents` | Agent authoring, MCP builder primitives, extension handler | `packages/agents/src/` |
| `@cinatra-ai/extensions` | Extension lifecycle (install/activate/teardown), registry | `packages/extensions/src/` |
| `@cinatra-ai/mcp-server` | MCP server mount, auth plugins, credentials | `packages/mcp-server/src/` |
| `@cinatra-ai/a2a` | Agent-to-Agent JSON-RPC protocol, SSE bridge | `packages/a2a/src/` |
| `@cinatra-ai/workflows` | Workflow engine, approval lifecycle, trigger handling | `packages/workflows/src/` |
| `@cinatra-ai/chat` | Chat thread persistence, MCP module for chat history | `packages/chat/src/` |
| Extension Packages | Runtime-loadable connectors, artifact types, workflow templates | `extensions/cinatra-ai/*-connector/` |
| Instrumentation | Boot-time DI wiring, transport connector registration, Sentry/OTEL | `src/instrumentation.node.ts` |

## Pattern Overview

**Overall:** Modular monolith — Next.js App Router host with a pnpm workspace containing ~35 internal packages, a runtime extension system for pluggable connectors/agents/workflows, and an MCP (Model Context Protocol) boundary for LLM tool calling.

**Key Characteristics:**
- Server Components render per-user DB-backed content; all pages are `force-dynamic`
- LLM interactions funnel through a single `@cinatra-ai/llm` package (provider-agnostic abstraction)
- Extensions (connectors, artifact types, workflows) are installed at runtime via a private Verdaccio registry and hot-activated without restart
- MCP is the primary tool-calling protocol: the host exposes a `/api/mcp` endpoint and all LLM tools are registered as MCP modules
- Authorization uses a capability-based `ActorContext` (discriminated on `principalType`) enforced at every service boundary via `src/lib/authz/enforce.ts`
- DI wiring for SDK packages happens via side-effect imports in `src/instrumentation.node.ts` (registers providers into SDK globalThis slots)

## Layers

**Presentation Layer:**
- Purpose: React Server Components, Client Components, page layouts, UI primitives
- Location: `src/app/`, `src/components/`, `packages/design/`, `packages/sdk-ui/`, `packages/agent-ui-protocol/`
- Contains: RSC pages, `"use client"` interactive components, Tailwind/shadcn UI primitives
- Depends on: Host Library Layer, Internal Packages
- Used by: Browser / Next.js SSR runtime

**API Layer:**
- Purpose: HTTP route handlers — chat SSE stream, MCP JSON-RPC, A2A agent protocol, LLM bridge proxy
- Location: `src/app/api/`
- Contains: `route.ts` files, Zod validation schemas, streaming response builders
- Depends on: Host Library Layer, `@cinatra-ai/llm`, `@cinatra-ai/mcp-server`, `@cinatra-ai/a2a`
- Used by: Browser chat client, external MCP clients, A2A agent clients

**Host Library Layer:**
- Purpose: Business logic, DB stores, auth, DI registration, extension orchestration
- Location: `src/lib/`
- Contains: Drizzle ORM store functions, auth/session utilities, extension lifecycle ops, MCP server assembly
- Depends on: Internal Packages, Postgres, Redis
- Used by: API Layer, Presentation Layer (RSC server side)

**Authorization Kernel:**
- Purpose: RBAC enforcement — builds ActorContext from session, enforces policy at resource boundaries
- Location: `src/lib/authz/`
- Contains: `enforce.ts`, `actor-context.ts`, `policies.ts`, `audit.ts`, `scope-map.ts`
- Depends on: `src/lib/better-auth-db.ts`, Postgres
- Used by: API Layer, Host Library Layer, MCP boundary

**Internal Packages:**
- Purpose: Domain-scoped, independently versioned libraries for agents, LLM, chat, workflows, objects, etc.
- Location: `packages/*/src/`
- Contains: Domain logic, MCP modules (`integration/module.ts`), extension handlers, SDK contracts
- Depends on: Postgres (via DI-injected host adapters), each other via pnpm workspace links
- Used by: Host Library Layer, API Layer

**Extension Packages (Runtime):**
- Purpose: Pluggable connectors, artifact types, workflow templates installed at runtime
- Location: `extensions/cinatra-ai/*-connector`, `extensions/cinatra-ai/*-artifact`, `extensions/cinatra-ai/*-workflow`
- Contains: MCP modules, UI surfaces, schema configs, migration DSL
- Depends on: `@cinatra-ai/sdk-extensions`, `@cinatra-ai/extension-types`
- Used by: ExtensionRegistry (`src/lib/extensions.ts`), MCP server module assembly

## Data Flow

### Chat Request (Browser → LLM → SSE Response)

1. Browser POSTs `{ messages }` to `/api/chat` (`src/app/api/chat/route.ts:52`)
2. Route validates body with Zod `chatBodySchema`, checks LLM provider, resolves `ActorContext` via `requireActorContext()`
3. Route creates `ReadableStream` and calls `runChatTurn()` (`src/app/api/chat/runner.ts`)
4. `runChatTurn` imports registered transport connectors, resolves skill tools via `@cinatra-ai/llm:buildSkillTools`, resolves MCP tools via `resolveChatExternalMcpTools`
5. `@cinatra-ai/llm:stream()` calls the configured provider (OpenAI/Anthropic/Gemini adapter) with the assembled tool set
6. Tool calls are dispatched back through the MCP server modules (DB mutations, connector calls, etc.)
7. Events streamed as SSE (`event: token\ndata: {...}`) back to browser

### MCP Tool Call Path

1. LLM emits a tool call during streaming
2. `@cinatra-ai/llm` routes the call to the appropriate MCP module registered in `src/lib/mcp-server.ts`
3. MCP module performs DB read/write or calls external connector API
4. Result returned to LLM as `tool_result` message

### Extension Install Path

1. Admin triggers install (UI Server Action or API) → `src/lib/extension-install-pipeline.ts`
2. Pipeline: resolve signature verdict (`src/lib/extension-signature.ts`) → materialize tarball → record canonical install row → record host-port grants
3. `extensionRegistry.install()` fires; `createAgentExtensionHandler` / `createConnectorExtensionHandler` / etc. handle their kind
4. Activate hook wired in `src/lib/extension-activate-hook-wiring.ts` hot-activates extension in-process (no restart needed)

### A2A Agent Call Path

1. External agent POSTs JSON-RPC to `/api/a2a` (`src/app/api/a2a/route.ts`)
2. Bearer JWT verified via `verifyA2AAccessToken()` (`src/lib/a2a-auth.ts`)
3. `ActorContext` built from JWT claims via `resolveA2AActorContext()`
4. `getA2AMount()` (`src/lib/a2a-server.ts`) routes to the appropriate agent run handler
5. Response streamed as SSE via `toSseResponse()` from `@cinatra-ai/a2a`

**State Management:**
- Server state: Postgres via Drizzle ORM (`src/lib/drizzle-store.ts`)
- Background jobs: BullMQ (`src/lib/background-jobs.ts`)
- Client state: React context providers (`src/app/providers.tsx`, `src/context/`)
- MCP actor context: AsyncLocalStorage in `@cinatra-ai/mcp-server` (`packages/mcp-server/src/`)

## Key Abstractions

**ActorContext:**
- Purpose: Carries identity + permissions for every server-side operation; discriminated union on `principalType` (`HumanUser`, `ServiceAccount`, `ExternalA2AAgent`, `InternalWorker`, `System`)
- Files: `src/lib/authz/actor-context.ts`, `src/lib/authz/build-actor-context.ts`
- Pattern: Built at auth boundary; passed explicitly or via AsyncLocalStorage; never inferred mid-request

**ExtensionRegistry:**
- Purpose: Central registry that manages install/activate/teardown lifecycle for all extension kinds (agent, connector, artifact, workflow, skill)
- Files: `src/lib/extensions.ts`, `packages/extensions/src/`
- Pattern: Handlers registered at startup via side-effect imports; registry fires hooks on install/update/uninstall

**MCP Module:**
- Purpose: A self-contained set of MCP tool definitions mounted onto the MCP server for a given domain (agents, objects, chat, dashboards, connectors, etc.)
- Files: `packages/agents/src/integration/module.ts`, `packages/objects/src/integration/module.ts`, etc. (pattern: `packages/*/src/integration/module.ts` or `packages/*/src/mcp/module.ts`)
- Pattern: `create*Module()` factory returns `{ createDeterministicClient(), registerCapabilities() }`; assembled in `src/lib/mcp-server.ts`

**LLM Adapter:**
- Purpose: Provider-agnostic LLM interface; adapters translate unified `LlmMessage`/`LlmTool` types to OpenAI, Anthropic, Gemini SDKs
- Files: `packages/llm/src/adapters/`, `packages/llm/src/index.ts`
- Pattern: `stream()` / `buildSkillTools()` / `resolveDefaultAdapter()` are the call surface

## Entry Points

**Web Application (Next.js):**
- Location: `src/app/layout.tsx`
- Triggers: Browser navigation, Next.js SSR
- Responsibilities: Auth-gated root layout, setup wizard gate, nav permission resolution

**Boot / Instrumentation:**
- Location: `src/instrumentation.node.ts`
- Triggers: Next.js server startup (Node.js runtime only)
- Responsibilities: Sentry/OTEL init, DI slot wiring (transport connectors, email providers, objects provider, A2A provider), extension action guard registration

**Chat API:**
- Location: `src/app/api/chat/route.ts`
- Triggers: POST from browser chat UI
- Responsibilities: Validate request, resolve actor, build LLM tool set, stream SSE response

**MCP Server:**
- Location: `src/app/api/mcp/route.ts`, assembled in `src/lib/mcp-server.ts`
- Triggers: MCP client connections (LLM tool calls, external MCP clients)
- Responsibilities: Auth gate, route to appropriate MCP module

**A2A Endpoint:**
- Location: `src/app/api/a2a/route.ts`
- Triggers: External agent JSON-RPC calls
- Responsibilities: JWT auth, actor context resolution, agent run routing, SSE streaming

**CLI:**
- Location: `packages/cli/bin/`
- Triggers: `npx cinatra` or direct execution
- Responsibilities: Admin tooling, scaffolding

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop; background work via BullMQ workers; no worker_threads in hot path
- **Global state:** Module-level singletons for ExtensionRegistry (`packages/extensions/src/`), MCP server mount (`src/lib/mcp-server.ts`), actor context AsyncLocalStorage (`packages/mcp-server/src/`), DI slots in `@cinatra-ai/sdk-extensions` globalThis slots; all registered via `src/instrumentation.node.ts` side-effects
- **Circular imports:** Not detected in primary paths; cross-package DI is via SDK globalThis slots to break potential cycles between host and extension packages
- **Server-only enforcement:** Critical host modules begin with `import "server-only"` (enforced in `src/lib/`, `src/app/api/`, all package `index.ts` server exports) to prevent accidental client-bundle inclusion
- **Extension isolation:** Extension packages reference only `@cinatra-ai/sdk-extensions` (not host internals); host injects implementations via `requireExtensionAction()`, `requireA2AConnectionProvider()`, etc.
- **Dynamic rendering:** Root layout exports `export const dynamic = "force-dynamic"` — no static prerendering for auth-gated pages

## Anti-Patterns

### Importing host modules from extension packages

**What happens:** An extension package (`extensions/cinatra-ai/*-connector`) directly imports from `src/lib/` or from `packages/agents` host internals.
**Why it's wrong:** Breaks the extension isolation boundary; couples runtime-loadable code to host internals and defeats the SDK abstraction layer.
**Do this instead:** Extension packages import only `@cinatra-ai/sdk-extensions` or other `@cinatra-ai/*` SDK packages; host implementations are injected via DI slots (`requireExtensionAction()`, `requireObjectsProvider()`, etc.) registered in `src/instrumentation.node.ts`.

### Reading ActorContext from a body parameter

**What happens:** An API route or Server Action accepts `orgId`, `userId`, or `projectId` from the request body and uses it directly as the authorization boundary.
**Why it's wrong:** Lets callers escalate their own privileges; the tenant boundary must always derive from the authenticated session.
**Do this instead:** Resolve `ActorContext` from session via `requireActorContext()` (`src/lib/auth-session.ts`) or build it from the JWT in `resolveA2AActorContext()` (`src/app/api/a2a/actor-context-resolver.ts`); never trust caller-supplied identity.

### Skipping Zod validation at API boundaries

**What happens:** A route handler casts `await request.json() as MyType` without schema validation.
**Why it's wrong:** Missing optional fields (e.g. `representationRevisionId` on attachment refs) silently degrade downstream behavior without a clear 400 error.
**Do this instead:** Use `z.object(...).safeParse(raw)` and return a structured 400 on failure, as in `src/app/api/chat/route.ts:54-61`.

## Error Handling

**Strategy:** Fail-loud at validated boundaries (Zod schema rejection → 400); soft-fail at layout-level DB reads (`.catch()` with safe defaults to keep the app visible on transient DB errors); SSE errors sent as structured `event: error` frames rather than silent stream close.

**Patterns:**
- API routes: `safeParse` → structured 400; `try/catch` around `runChatTurn` → `send("error", { message })` SSE event
- Root layout: `Promise.all` with individual `.catch(() => defaultValue)` guards per DB call (`src/app/layout.tsx:93-108`)
- Extension lifecycle: typed `ConnectorRequiresRebuildError` surface from connector handler rather than raw throws
- Background jobs: BullMQ workers with their own error queue; not propagated to HTTP layer

## Cross-Cutting Concerns

**Logging:** `console.error/console.warn` throughout; structured OTEL spans via `src/lib/otel-bootstrap.ts`; Sentry error capture via `sentry.server.config.ts` / `sentry.client.config.ts`
**Validation:** Zod at all HTTP API boundaries; TypeScript strict mode with `tsconfig.json`
**Authentication:** Better Auth (`src/lib/auth.ts`) for session management; OAuth via `@cinatra-ai/google-oauth-connection`; MCP/A2A use Bearer JWT verified against Better Auth's OAuth provider plugin

---

*Architecture analysis: 2026-06-09*
