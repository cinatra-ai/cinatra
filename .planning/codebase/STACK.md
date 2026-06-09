# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript ~6.0.3 - All application source (`src/`, `packages/`)
- JavaScript (ESM) - Build scripts (`scripts/*.mjs`)

**Secondary:**
- Python - WayFlow agent executor bridge (`docker/wayflow/agent_loader.py`, `docker/wayflow/cinatra_executors/`)
- PHP - WordPress and Drupal seed scripts (`docker/wordpress/seed-content.php`, `docker/drupal/seed-content.php`)

## Runtime

**Environment:**
- Node.js 24 (LTS) — confirmed via `Dockerfile` (`FROM node:24-alpine`) and local version

**Package Manager:**
- pnpm 11.1.2 (sha512 pinned in `package.json` `packageManager` field)
- Lockfile: `pnpm-lock.yaml` present and committed

## Frameworks

**Core:**
- Next.js 16.2.6 - Full-stack React framework, App Router; entry via `src/app/`
- React 19.2.6 - UI rendering
- tRPC 11.17.0 - Type-safe API layer (`@trpc/server`)

**Auth:**
- better-auth 1.6.11 - Authentication framework; configured in `src/lib/auth.ts`
- `@better-auth/oauth-provider` 1.6.11 - OAuth 2.0 provider plugin
- `@better-auth/passkey` 1.6.11 - Passkey authentication plugin

**Testing:**
- Vitest 4.1.6 - Unit test runner; config at `vitest.config.ts`
- Playwright 1.60.0 - E2E testing; configs under `tests/e2e/config/`

**Build/Dev:**
- esbuild 0.25.12 - Bundling for auth-migrate bundle and dev scripts
- tsx 4.22.0 - TypeScript execution for scripts
- Tailwind CSS 4.3.0 - Utility CSS
- `@tailwindcss/postcss` 4.3.0 - PostCSS integration

## Key Dependencies

**Critical:**
- `drizzle-orm` 0.45.2 - ORM for PostgreSQL access; used in `src/lib/drizzle-store.ts` and `packages/` sub-stores
- `bullmq` 5.76.9 - Background job queue over Redis; bootstrapped in `src/lib/background-jobs.ts`
- `ioredis` 5.10.1 - Redis client (used by BullMQ and direct cache ops)
- `pg` 8.20.0 - PostgreSQL client (low-level DB queries via `src/lib/postgres-sync.ts`)
- `@modelcontextprotocol/sdk` 1.29.0 - MCP protocol SDK; core to agent tool/connector architecture
- `@sentry/nextjs` 10.53.1 - Error tracking; bootstrapped via `src/lib/sentry.ts`
- `@nangohq/node` 0.70.3 + `@nangohq/frontend` 0.70.3 - Nango OAuth connector manager; accessed via `src/lib/nango.ts`

**Infrastructure:**
- `@opentelemetry/sdk-trace-node` 1.30.0 + `@opentelemetry/sdk-trace-base` 1.30.0 - Distributed tracing; initialized in `src/lib/otel-bootstrap.ts`
- `@queuedash/api` + `@queuedash/ui` 3.19.0 - BullMQ dashboard UI
- `@tanstack/react-query` 5.100.10 - Client-side data fetching
- `@tanstack/react-table` 8.21.3 - Table primitives
- `zod` 4.4.3 - Schema validation
- `undici` 8.3.0 - HTTP client (fetch polyfill / direct usage)
- `sonner` 2.0.7 - Toast notifications
- `lucide-react` 1.16.0 - Icon library
- `@radix-ui/*` suite - Headless UI primitives (avatar, checkbox, dialog, dropdown, select, tabs, tooltip, etc.)
- `react-hook-form` 7.76.0 + `@hookform/resolvers` 5.2.2 - Form handling
- `date-fns` 4.1.0 - Date utilities
- `marked` 18.0.3 - Markdown rendering
- `katex` 0.16.47 - Math rendering
- `papaparse` 5.5.3 - CSV parsing
- `bpmn-moddle` 10.0.0 + `moddle-xml` 12.0.0 - BPMN workflow model parsing
- `cheerio` 1.2.0 - HTML parsing (web scrape/content workflows)

**Monorepo workspace packages (`packages/`):**
- `@cinatra-ai/llm` - LLM provider abstraction (Anthropic, OpenAI, Gemini adapters); `packages/llm/src/adapters/`
- `@cinatra-ai/agents` - Agent runtime
- `@cinatra-ai/connectors` + `@cinatra-ai/connectors-catalog` - Connector framework
- `@cinatra-ai/mcp-server` - MCP server hosting
- `@cinatra-ai/mcp-client` - MCP client
- `@cinatra-ai/permissions` - RBAC / authz
- `@cinatra-ai/skills` - Skill registry
- `@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`, `@cinatra-ai/sdk-dashboard` - Extension SDK surface
- `@cinatra-ai/notifications` - Notification system
- `@cinatra-ai/workflows` - Workflow engine
- `@cinatra-ai/projects` - Projects store
- `@cinatra-ai/errors` - Error handling + Sentry integration

## Configuration

**Environment:**
- `.env.example` present (never read — contains configuration templates)
- `.env.local` expected for local dev (loaded via `--env-file=.env.local` in scripts)
- Key required variables: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `REDIS_URL`, `CINATRA_ENCRYPTION_KEY`, `NANGO_SECRET_KEY`, `NANGO_SERVER_URL`, `SENTRY_DSN`, `RESEND_API_KEY`, `OTEL_INGEST_TOKEN`
- `CINATRA_RUNTIME_MODE` controls feature flags for runtime behavior

**Build:**
- `tsconfig.json` - TypeScript config; `moduleResolution: bundler`, strict mode, `@/*` aliased to `./src/*`
- `next.config.*` - Next.js build config
- `eslint.config.*` - ESLint with `@typescript-eslint` plugin
- `vitest.config.ts` - Vitest test config
- `pnpm-workspace.yaml` - Monorepo workspace definition
- `.pnpmfile.cjs` - pnpm install hooks (lockfile checksum pinned)

**Linting/Type-checking:**
- ESLint 10.4.0 with `eslint-config-next` 16.2.6 and `@typescript-eslint` 8.59.3
- `@typescript/native-preview` 7.0.0-dev - Fast type-check via `tsgo --noEmit` (`typecheck` script)
- Standard `tsc --noEmit` available as `typecheck:slow`

## Platform Requirements

**Development:**
- Node.js 24, pnpm 11.1.2
- Docker Compose for local services (Postgres 17, Redis 7, Nango, Verdaccio, Neo4j, MariaDB, WordPress, Drupal)
- Setup via `pnpm setup:dev` → `packages/cli/bin/cinatra.mjs setup dev`

**Production:**
- Docker image built from `Dockerfile` (`node:24-alpine`), multi-stage: `build` → runtime
- Deployed as containerized Next.js server (`next start`)
- Companion services expected: PostgreSQL, Redis, Nango, Neo4j (optional knowledge graph)

---

*Stack analysis: 2026-06-09*
