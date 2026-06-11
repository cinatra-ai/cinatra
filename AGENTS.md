# AGENTS.md

A map of this repository for contributors and coding agents. For product
concepts, guides, and reference material, see **[docs.cinatra.ai](https://docs.cinatra.ai)**.

## What Cinatra is

Cinatra is an open source AI workspace for teams — a shared, persistent,
browser-based environment where people, AI assistants, and autonomous agents
work together. It turns isolated prompts into durable workflows with state,
tooling, handoffs, approvals, and real operational outputs. Agents, connectors,
skills, objects, and dashboards live in one capability fabric, exposed through a
Model Context Protocol (MCP) server and composed into long-running, background
workflows.

> Cinatra is under active development and is **not production ready**. Run it for
> evaluation, local development, and self-hosted experimentation. APIs, schemas,
> and the extension contract may change without notice.

## Repository layout

| Path | What lives here |
|------|-----------------|
| `src/` | The Next.js application (App Router): pages, server components, API routes, and host wiring (`src/lib/`). |
| `packages/` | The workspace packages — the platform's building blocks (see below). Each is a `@cinatra-ai/*` package with its own `README.md`. |
| `scripts/` | Setup, dev-server, validation, and audit tooling (`setup.sh`, `dev-server.mjs`). |
| `contracts/` | Cross-surface contract fixtures used by end-to-end tests. |
| `migrations/` | Versioned migrations for the core store schema: node-pg-migrate code modules under `migrations/core/` (`core__NNNN_description.mjs` + manifest entry, `pgmigrations` ledger); the legacy one-shot `NNNN_description.sql` artifacts are retained append-only. Convention in `migrations/README.md`. |
| `docs/` | Pointer to the documentation site; the source lives in [`cinatra-ai/docs`](https://github.com/cinatra-ai/docs). |
| `docker-compose.yml`, `Makefile` | The local development stack (PostgreSQL, Redis, and optional supporting services) and the dev-loop entry points. |
| `tests/` (Playwright configs under `tests/e2e/config/`) | End-to-end test suites. Unit tests are package-local. |

Root config of note: `package.json` (workspace + scripts), `pnpm-workspace.yaml`,
`tsconfig.json` (path aliases), `next.config.ts`, `eslint.config.mjs`,
`vitest.config.ts`.

## Packages

The platform is split into ~35 workspace packages under `packages/*`. Each has a
`README.md` and a `package.json` description — read those for the authoritative
surface. Grouped overview:

- **Agent core** — `agents` (template/version/run lifecycle, workflow
  compilation, triggers, orchestration), `workflows` (a versioned, scheduled
  DAG engine over Postgres), `trigger` and `trigger-email-send` (run triggers),
  `a2a` and `agent-ui-protocol` (Agent-to-Agent calling and UI event streaming).
- **LLM** — `llm` (the unified orchestration layer: provider adapters, MCP tool
  injection, skill delivery, usage telemetry).
- **MCP** — `mcp-server` (the mountable MCP server: Streamable HTTP transport,
  OAuth 2.0, admin UI) and `mcp-client` (server-only client + in-process
  transport for invoking primitives).
- **Connectors** — `connectors` (the installed-connector index grid),
  `connectors-catalog` (dependency-free built-in connector descriptors),
  `google-oauth-connection` (Google OAuth runtime facade).
- **Marketplace & registries** — `registries` (registry client + dependency
  resolution with lockfiles and integrity checks), `marketplace-sync`,
  `marketplace-mcp-client`, `marketplace-application-reconcile`.
- **Extensions** — `extensions` (host-side lifecycle dispatcher, installed
  manifest, runtime capability discovery, safety gates), `extension-types`,
  `sdk-extensions` (the author-facing extension ABI).
- **Objects, projects, permissions** — `objects` (typed-object substrate with
  taxonomy, classification, and `objects_*` primitives), `projects` (four-tier
  ownership + N:M project access), `permissions` (members, roles, grants).
- **Dashboards, notifications, chat** — `dashboards` and `sdk-dashboard`
  (dashboards glue + extraction-ready SDK over drizzle-cube), `notifications`
  (Postgres-backed, SSE-streamed), `chat` (the conversational assistant UI).
- **Skills & metrics** — `skills` (the catalog for agent `SKILL.md` files),
  `metric-usage-api` (captures token/usage events), `metric-cost-api` (prices
  events, persists to Postgres, serves the cost dashboard).
- **SDKs, design, CLI, infra** — `sdk-ui` (design-strict React primitives),
  `design` (tokens, fonts, brand assets), `artifacts` (binary artifact storage
  contracts), `errors` (Sentry helpers), and `cli` (the `cinatra` command-line
  tool for setup and operations).

## Architecture at a glance

- **Next.js app (`src/`).** App Router with server components and server
  actions. Route files delegate to per-package screens via
  `src/app/plugins-registry.tsx` / `plugins-routes.tsx`. API routes live under
  `src/app/api/` (auth, agents, chat, dashboards, extensions, webhooks, and
  more).
- **MCP server.** Every agent and platform capability is exposed as an MCP
  primitive. The server mounts at `src/app/api/mcp/route.ts` (from
  `@cinatra-ai/mcp-server`); the same primitives are called internally in-process
  through `@cinatra-ai/mcp-client`. Primitives use underscore-separated names
  (e.g. `objects_list`).
- **LLM orchestration.** Provider access is centralized in `@cinatra-ai/llm` —
  callers never reach provider SDKs directly. The layer injects the Cinatra MCP
  tool, delivers skills, and records usage telemetry across OpenAI, Anthropic,
  and Gemini adapters.
- **Background jobs.** Long-running agent and workflow executions run on BullMQ
  over Redis (`src/lib/background-jobs.ts`), so work survives page reloads and
  resumes across network drops.
- **Persistence.** PostgreSQL via Drizzle ORM (`src/lib/drizzle-store.ts`,
  `src/lib/database.ts`). Authentication is handled by Better Auth
  (`src/lib/auth.ts`); the first user to register becomes the platform admin.

## Local development

Prerequisites: **Node.js 24.x**, **pnpm** (pinned in the repo — use
`corepack pnpm`), and **Docker** with Compose for the bundled PostgreSQL and
Redis services.

```bash
git clone https://github.com/cinatra-ai/cinatra.git
cd cinatra
make setup    # install deps, start supporting services, configure the app
make dev      # bring up infrastructure and start the Next.js dev server
```

Open <http://localhost:3000>. Other useful `make` targets: `make down` (stop
services, keep data), `make reset` (soft reset of app/auth data), `make logs`,
and `make clean` (wipe Docker volumes).

### Validation

Run these before opening a pull request:

```bash
pnpm typecheck    # fast type check (must pass cleanly)
pnpm lint         # ESLint
pnpm build        # Next.js production build
```

Unit tests are package-local — run them with `pnpm --filter <package> test`
where a package has them. End-to-end suites use Playwright (`pnpm test:e2e:*`).

## How to contribute

Bug reports, agents, connectors, skills, documentation, and code are all
welcome. Read **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full development
setup, branching, and pull-request flow. Please also review the
[Code of Conduct](CODE_OF_CONDUCT.md).

For security issues, do **not** open a public issue — follow the private
disclosure path in **[SECURITY.md](SECURITY.md)**.

## Docs

Everything beyond this map lives at **[docs.cinatra.ai](https://docs.cinatra.ai)**:

- [User Guide](https://docs.cinatra.ai/guides/user/)
- [Admin Guide](https://docs.cinatra.ai/guides/admin/)
- [Hosting Guide](https://docs.cinatra.ai/guides/hosting/)
- [Developer Guide](https://docs.cinatra.ai/guides/developer/)
- [MCP Guide](https://docs.cinatra.ai/references/mcp/)
