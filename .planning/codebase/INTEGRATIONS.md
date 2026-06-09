# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**AI / LLM Providers:**
- Anthropic Claude - Primary LLM provider
  - SDK/Client: `@cinatra-ai/anthropic-connector` (workspace), adapter in `packages/llm/src/adapters/anthropic.ts`
  - Auth: connector config stored via Nango or direct env in connector package
- OpenAI - Secondary LLM provider
  - SDK/Client: `@cinatra-ai/openai-connector` (workspace), adapter in `packages/llm/src/adapters/openai.ts`
  - Connection config stored via `src/lib/openai-connection-store.ts`
- Google Gemini - Third LLM provider
  - SDK/Client: `@cinatra-ai/gemini-connector` (workspace), adapter in `packages/llm/src/adapters/gemini.ts`

**Email:**
- Resend - Transactional email delivery
  - SDK/Client: `@cinatra-ai/resend-connector` (workspace)
  - Auth: `RESEND_API_KEY` env var

**OAuth Connector Manager:**
- Nango - OAuth 2.0 connection lifecycle manager for all third-party integrations
  - SDK/Client: `@nangohq/node` 0.70.3 (server), `@nangohq/frontend` 0.70.3 (client)
  - Entry: `src/lib/nango.ts` (re-exports from `@cinatra-ai/nango-connector`)
  - UI: `src/lib/nango-connect-ui.ts`, `src/lib/nango-settings-section.ts`
  - Auth: `NANGO_SECRET_KEY`, `NANGO_SERVER_URL` env vars
  - Webhook receiver: `src/app/api/nango/webhook/route.ts`

**Social / Content Integrations (via Nango connectors):**
- LinkedIn - `@cinatra-ai/linkedin-connector` — posting, profile data; `src/lib/linkedin-api.ts`
- YouTube - `@cinatra-ai/youtube-connector`; `src/lib/youtube-api.ts`
- GitHub - `@cinatra-ai/github-connector`; `src/lib/github-api.ts`
- Gmail - `@cinatra-ai/gmail-connector`
- Google Calendar - `@cinatra-ai/google-calendar-connector`
- Google OAuth (standalone) - `@cinatra-ai/google-oauth-connector`, `@cinatra-ai/google-oauth-connection`; configured via `getGoogleOAuthSettings()` in `src/lib/auth.ts`

**CRM / Sales:**
- Apollo - `@cinatra-ai/apollo-connector` — contact/company prospecting
- Twenty CRM - `@cinatra-ai/twenty-connector` — open-source CRM (self-hosted via docker-compose Twenty DB)

**Content Management:**
- WordPress - `@cinatra-ai/wordpress-assistant-connector`, `@cinatra-ai/wordpress-mcp-connector`
  - REST API client: `src/lib/wordpress-api.ts`
  - Webhook receiver: `src/app/api/webhooks/wordpress/route.ts`
  - Auth: Application Password stored in connector config
- Drupal - `@cinatra-ai/drupal-assistant-connector`, `@cinatra-ai/drupal-mcp-connector`
  - Companion Drupal module cloned to `dev/drupal-module/cinatra`

**Web / Scraping:**
- Apify - `@cinatra-ai/apify-connector` — web scraping / automation

**Networking / Infrastructure:**
- Tailscale - `@cinatra-ai/tailscale-connector` — private network mesh for agent-to-agent communication

**Agent-to-Agent (A2A):**
- Internal A2A protocol - `@cinatra-ai/a2a-server-connector`; server endpoint `src/app/api/a2a/`
- WayFlow - External agent executor bridge; `src/lib/wayflow-bridge-auth.ts`; accessed via `WAYFLOW_BASE_URL`

**Social Media (aggregated):**
- `@cinatra-ai/social-media-connector` — generic social posting facade
- `@cinatra-ai/media-feeds-connector` — media feed aggregation

**Knowledge Graph (optional):**
- Graphiti / `zepai/knowledge-graph-mcp` — MCP-based knowledge graph; runs as local service via docker-compose Neo4j backend

## Data Storage

**Databases:**
- PostgreSQL 17 (primary application DB)
  - ORM: Drizzle ORM (`drizzle-orm` 0.45.2); store in `src/lib/drizzle-store.ts`
  - Direct client: `pg` 8.20.0 via `src/lib/postgres-sync.ts`
  - Connection: `DATABASE_URL` / standard Postgres env vars; `CINATRA_DB_PROD_HOSTS` for production host validation
- PostgreSQL 16 — Twenty CRM dedicated DB; container `cinatra-twenty-db-1` in `docker-compose.yml`
- PostgreSQL 15 — Nango dedicated DB in `docker-compose.yml`
- Supabase (optional overlay) — `SUPABASE_DB_URL`, `SUPABASE_SCHEMA` env vars; `src/lib/postgres-sync.ts` references these for Supabase-hosted deployments
- Neo4j 5.26 (optional) — Knowledge graph; container in `docker-compose.yml`
- MariaDB 11.4 — WordPress DB in local docker-compose

**File Storage:**
- Local filesystem — extension bundles, skill packages, agent artifacts stored on-disk in container
- Verdaccio 6 — Private npm registry for extension packages; container in `docker-compose.yml`; config `docker/verdaccio/config.yaml`

**Job Queue / Caching:**
- Redis 7 — BullMQ job queue backend + general caching
  - Client: ioredis 5.10.1; bootstrapped in `src/lib/background-jobs.ts`
  - Connection: `REDIS_URL` env var
  - Nango also uses Redis: `NANGO_REDIS_URL: redis://redis:6379`

## Authentication & Identity

**Auth Provider:**
- better-auth 1.6.11 (self-hosted, database-backed)
  - Implementation: `src/lib/auth.ts`; DB tables via `src/lib/better-auth-db.ts`
  - Plugins: OAuth provider, Passkey, MCP server auth, custom organization/membership bootstrap
  - Google OAuth integration via `@cinatra-ai/google-oauth-connection`
  - Config: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_CONSOLE_URL` env vars
  - Client-side: `@daveyplate/better-auth-ui` 3.4.0

**Service Accounts:**
- Internal service account tokens: `src/lib/service-accounts.ts`
- MCP Bearer JWT: `src/lib/agent-run-mcp-actor-token.ts`
- WayFlow bridge: shared-secret `CINATRA_BRIDGE_TOKEN` header; `src/lib/wayflow-bridge-auth.ts`
- Marketplace tokens: `MARKETPLACE_ADMIN_TOKEN`, `MARKETPLACE_INSTANCE_TOKEN`, `MARKETPLACE_SYNC_WORKER_TOKEN`

**Extension Signing:**
- `CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS`, `CINATRA_EXTENSION_REQUIRE_SIGNATURES` — package signature verification for installed extensions

## Monitoring & Observability

**Error Tracking:**
- Sentry — `@sentry/nextjs` 10.53.1 + `@sentry/opentelemetry` 10.53.1
  - Server config: `src/lib/sentry.ts` (re-exports from `@cinatra-ai/errors/server`)
  - Shared config: `src/lib/sentry-shared.ts`
  - Config: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`

**Distributed Tracing:**
- OpenTelemetry — `@opentelemetry/sdk-trace-node` + `@opentelemetry/sdk-trace-base` 1.30.0
  - Bootstrap: `src/lib/otel-bootstrap.ts`; initialized from `src/instrumentation.node.ts`
  - Custom span exporter: `@cinatra-ai/metric-cost-api` (`PostgresSpanExporter`) — writes traces to Postgres
  - Config: `OTEL_INGEST_TOKEN`, `OTEL_SERVICE_NAME` env vars

**Logs:**
- Structured logging via `src/lib/logging.ts` and `src/lib/mcp-logging.ts`
- Log redaction for sensitive values: `packages/llm/src/log-redaction.ts`

## CI/CD & Deployment

**Hosting:**
- Docker container (`Dockerfile`; `node:24-alpine` multi-stage build)
- `next start` as production server

**CI Pipeline:**
- GitHub Actions; workflows under `.github/workflows/`
- Key workflows: `build-image.yml`, `codeql.yml`, `validate-agents.yml`, `skill-match-eval.yml`, `wp-drupal-uat.yml`, `design-visual-verify.yml`, `dashboard-live-verify.yml`
- Reusable extension release CI referenced in memory (`reusable-extension-release.yml`)

**Private Registry:**
- Verdaccio 6 — local private npm registry for `@cinatra-ai/*` packages during dev; `docker/verdaccio/config.yaml`
- `CINATRA_AGENT_REGISTRY_URL`, `CINATRA_AGENT_REGISTRY_TOKEN`, `CINATRA_AGENT_REGISTRY_SCOPE` — production registry credentials

## Environment Configuration

**Required env vars:**
- `BETTER_AUTH_SECRET` — auth session signing key
- `BETTER_AUTH_URL` — public auth base URL
- `CINATRA_ENCRYPTION_KEY` — data encryption key (auto-generated in dev via `src/lib/dev-encryption-key-bootstrap.ts`)
- `REDIS_URL` — Redis connection string
- `NANGO_SECRET_KEY` + `NANGO_SERVER_URL` — Nango OAuth manager
- `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` — error tracking
- `RESEND_API_KEY` — email sending
- `OTEL_INGEST_TOKEN` — OpenTelemetry trace export
- `CINATRA_BRIDGE_TOKEN` — WayFlow bridge shared secret
- `MARKETPLACE_INSTANCE_TOKEN` — marketplace sync auth

**Secrets location:**
- `.env.local` for local development (not committed)
- `.env.example` documents available variables (exists, never read for secrets)
- `.github/secrets-required.txt` documents required GitHub Actions secrets

## Webhooks & Callbacks

**Incoming:**
- `src/app/api/nango/webhook/route.ts` — Nango OAuth lifecycle events (token refresh, connection status)
- `src/app/api/webhooks/wordpress/route.ts` — WordPress plugin events

**Outgoing:**
- WayFlow bridge callbacks: `WAYFLOW_BASE_URL` — agent executor bridge
- Nango outgoing webhook registration managed by `src/lib/nango-connectors.ts`
- A2A agent-to-agent calls via `src/app/api/a2a/` routes

---

*Integration audit: 2026-06-09*
