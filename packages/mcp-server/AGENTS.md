# AGENTS.md — @cinatra-ai/mcp-server

## Purpose

This package provides the MCP server transport, OAuth2 authorization, and administration UI for the Cinatra application.

## Capability Autodiscovery

`createMcpServerMount` accepts two optional fields on `CreateMcpServerMountOptions`:

- `serverInstructions?: string` — Passed to `McpServer({ instructions })` constructor. Sent in every `initialize` response so MCP clients learn the supported protocols without a user-supplied system prompt. Value comes from `CINATRA_MCP_INSTRUCTIONS` (reads `packages/skills-cinatra/skills/mcp-autodiscovery/SKILL.md` at module init).
- `serverExperimental?: Record<string, unknown>` — Passed to `server.registerCapabilities({ experimental })` **before** `server.connect(transport)`. Must precede `connect` — the SDK throws `AlreadyConnected` if called after. Value comes from `CINATRA_MCP_EXPERIMENTAL` (`io.cinatra.protocols` with `agUi`, `a2a`, `a2ui` version fields).

Both are wired in `src/lib/mcp-server.ts` from `@/lib/mcp-instructions`.

## Public base URL

Cinatra used to manage a Cloudflare quick tunnel automatically; that lifecycle is gone. The public MCP base URL is now operator-supplied:

- Admins enter the URL at `/configuration/development?tab=tunnel`. The form calls `setMcpPublicBaseUrl()` in `src/llm-credentials.ts`, which writes `{ publicBaseUrl, publicBaseUrlSource: "manual" }` to `connector_config:mcp_server`.
- `getMcpPublicBaseUrl()` / `getPublicMcpServerUrl()` / `getTrustedTokenOrigins()` honor every source EXCEPT `"cli"` — that was the retired cloudflared quick tunnel, whose process no longer runs, so a `"cli"` URL is always dead. `"manual"` (the dev-tab form) plus legacy operator-managed sources (`"external"`, `"tailscale-funnel"`, …) are all live URLs; they're honored and reported back as `"manual"` (the one canonical source going forward).
- Operators are expected to run their own tunnel (Tailscale Funnel, named Cloudflare Tunnel, ngrok with a reserved domain, …) pointing at `http://localhost:3000`, then paste the public URL into the dev tab.

## Administration page

`overviewPage()` in `src/index.tsx` renders `/configuration/mcp`. Key behaviour:

- **Public base URL form** — single text field bound to `connector_config:mcp_server.publicBaseUrl` via `PublicBaseUrlHandlers`. Available in both dev and production (in production, normally set via `BETTER_AUTH_URL` env, but the form is kept as an override surface).
- **Check reachability button** — disabled when `!settings.publicBaseUrl`. On POST, fetches the public MCP endpoint, expects `401` with `WWW-Authenticate: Bearer`. Diagnostic only; failures never mutate stored state.
- **Result modal** — shows the result badge, raw HTTP request line, and raw HTTP response (status line + `WWW-Authenticate` + first 400 chars of body).

## LLM provider OAuth access (client_credentials)

### Overview

`/configuration/permissions?tab=mcp` lets admins grant LLM providers (OpenAI, Gemini, Anthropic) OAuth `client_credentials` access to the MCP server. Each provider gets a dedicated client (`cinatra-llm-<provider>`) provisioned via `LlmAccessHandlers` in `src/index.tsx`.

### JWT requirement — verifyMcpAccessToken only accepts JWTs

`verifyMcpAccessToken` uses JWKS verification. It only handles JWTs (three dot-separated parts). Better Auth issues an **opaque token** by default for `client_credentials` — a 32-char random string that JWKS cannot verify, causing a 401.

**Every `client_credentials` token request must include `resource: getLocalMcpServerUrl("/api/mcp")`** (RFC 8707). This triggers JWT issuance with `aud = http://localhost:3000/api/mcp`, which JWKS can verify offline.

### validAudiences — required plugin configuration

Better Auth validates the `resource` parameter against `opts.validAudiences`. The default allowlist is `[baseURL]` = `["http://localhost:3000"]`. Without explicit configuration, `resource: "http://localhost:3000/api/mcp"` fails with `invalid_request: requested resource invalid`.

`createMcpServerAuthPlugins` configures this:
```ts
oauthProvider({
  validAudiences: [getLocalMcpServerUrl(mcpBasePath)],  // "http://localhost:3000/api/mcp"
  // ...
})
```

This is intentional OAuth 2.0 design. Better Auth provides no `defaultAudience` or per-client `audience` override — `resource` + `validAudiences` is the only mechanism. Confirmed from `@better-auth/oauth-provider@1.5.6` source.

### Grant / Revoke flow (LlmAccessHandlers)

- **POST** (Grant): deletes any existing client for the provider (best-effort), then creates a fresh one via `auth.api.createOAuthClient` directly — avoids a self-referential HTTP fetch that deadlocks in Turbopack dev (HTTP 408).
- **DELETE** (Revoke): calls `auth.api.deleteOAuthClient` (best-effort, `.catch(() => undefined)`), then clears stored credentials. CLI-provisioned clients that don't exist in Better Auth must not block revocation.

`auth.api.*` direct calls run the same Better Auth middleware chain as the HTTP path — no security bypass.

### Credentials storage

`writeLlmMcpCredentials` / `getLlmMcpCredentials` in `src/llm-credentials.ts` store per-provider `{ clientId, clientSecret, scope, blockedToolPatterns }` in the database under the `llm_mcp_access` administration key.

### revalidatePath in background callbacks

`writeMountedSettings` calls `revalidatePath(adminBasePath)`. The call is wrapped in try/catch because Next.js throws when `revalidatePath` runs outside a request context. Settings are persisted before the try/catch so persistence is never affected.

## Dev-admin bypass

`src/dev-admin-bypass.ts` owns the dev-only MCP admin bypass policy. Three guards (`NODE_ENV != production`, `CINATRA_MCP_DEV_ADMIN_BYPASS=true`, request reaches a trusted dev host) must all hold for the MCP transport to skip OAuth verification AND stamp `platformRole: "platform_admin"` on the request.

The "trusted dev host" tier covers:

- **Loopback** — `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`. URL hostname must match; `x-forwarded-host` is a VETO signal only (present-and-non-loopback or present-and-malformed rejects).
- **Env-allowlisted external hostname** — operator names hostnames in `CINATRA_MCP_DEV_TRUSTED_HOSTS=foo,bar`. URL hostname must literally match an entry; `x-forwarded-host` is ignored on this branch so spoofing it cannot widen trust. DB-stored `externalUrl` is intentionally NOT consulted.

`shouldGrantDevAdminBypass` and `isTrustedDevHost` are pure helpers — keep them that way. The bypass extends ONLY to the OAuth-skip + admin-bypass paths in `index.tsx`. The localhost-admin actor identity fallback (`actor-identity.ts`) and the A2A_DEV_BYPASS org fallback (`index.tsx`) deliberately stay strict-loopback — extending those would impersonate the first admin user from non-loopback callers.

See `https://docs.cinatra.ai/references/mcp/patterns/` § "Local-dev MCP admin bypass" for the security implications and operator guidance.

## Validation

After changes to this package:

```bash
pnpm --filter @cinatra-ai/mcp-server typecheck
```

Check that `llm-credentials.ts` and `index.tsx` compile cleanly (no `any` leaks, no missing `server-only` guard).

## Project Scoping — McpRequestContext extension

`McpRequestContext` includes `projectContext?: { projectId: string | null }`. Set by the BullMQ run worker before invoking the run body, and read by `upsertObject`/`upsertObjectAndEnqueue` (and artifact-creation semantic-artifact INSERT) for D1 write-time inheritance with substrate exclusion. The frame is always-established (even when projectId is NULL) to defend against stale BullMQ-pool frames leaking into a non-project run.

The McpRequestContext `a2aActorContext` shape also carries `projectGrants` end-to-end — `buildActorContextFromPrimitive` consumes carrier-forwarded grants gated on `actorType === "a2a"`.
