# AGENTS.md — @cinatra-ai/mcp-server

## Purpose

This package provides the MCP server transport, OAuth2 authorization, and administration UI for the Cinatra application.

## Capability Autodiscovery

`createMcpServerMount` accepts two optional fields on `CreateMcpServerMountOptions`:

- `serverInstructions?: string` — Passed to `McpServer({ instructions })` constructor. Sent in every `initialize` response so MCP clients learn the supported protocols without a user-supplied system prompt. Value comes from `CINATRA_MCP_INSTRUCTIONS` (reads `packages/skills-cinatra/skills/mcp-autodiscovery/SKILL.md` at module init).
- `serverExperimental?: Record<string, unknown>` — Passed to `server.registerCapabilities({ experimental })` **before** `server.connect(transport)`. Must precede `connect` — the SDK throws `AlreadyConnected` if called after. Value comes from `CINATRA_MCP_EXPERIMENTAL` (`io.cinatra.protocols` with `agUi`, `a2a`, `a2ui` version fields).

Both are wired in `src/lib/mcp-server.ts` from `@/lib/mcp-instructions`.

## Delegated-chat admission (cinatra#2817)

Two further optional fields on `CreateMcpServerMountOptions` carry the app-layer state the
delegated-chat perimeter decides from. Both are app-wired because the package must not reach for
the connector catalog or the durable store itself:

- `resolvePrimitiveCapabilityKeys?: () => Promise<(name: string) => string | null | undefined>` —
  resolves each planned primitive's capability key for the request-scoped capability plan.
- `loadDelegatedChatAdmissionSnapshot?: () => Promise<DelegatedChatAdmissionSnapshot>` — loads the
  ONE immutable admission snapshot the request decides against, before registration.

**Omitting the snapshot loader CLOSES the delegated-chat surface; it never opens it.** A
delegated-chat build handed no snapshot decides against an explicitly unavailable one, so every
primitive is refused with `admission_store_unavailable`. A caller that forgets to wire it loses the
chat surface rather than silently gaining an ungated one.

The decision itself is `evaluateDelegatedChatAdmission(planned, snapshot)` in
`src/delegated-chat-admission.ts`, beside the record and digest it evaluates against — one pure
function shared by registration filtering, catalog derivation, the call-time guard and the
in-process self-invoker.

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

`src/dev-admin-bypass.ts` owns the dev-only MCP admin bypass policy. Four guards must all hold for the MCP transport to skip OAuth verification AND stamp `platformRole: "platform_admin"` on the request:

1. `NODE_ENV != production`.
2. `CINATRA_MCP_DEV_ADMIN_BYPASS=true`.
3. NO forwarded header ON THE CONNECTION AS IT ARRIVED — `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto` and `forwarded` each refuse outright, present at any value. Presence is read from the INGRESS snapshot taken with the socket peer, NEVER from the route handler's own `Request` headers: the dev server synthesises the forwarded chain on the way in, so a handler always sees one and a check there would refuse every request, the local operator's included.
4. The CONNECTING SOCKET's peer address is loopback AND the request carries this boot's local credential in `x-cinatra-dev-local-token`.

**No hostname is read.** A request's `Host` (and the URL authority derived from it) is written by the caller, and the dev server synthesises the forwarded chain from that same header, so a request whose headers all say "localhost" proves nothing — anyone who can reach a loopback listener through a proxy that terminates on this machine can compose one. The socket peer comes from the runtime's connection info (`src/local-connection.ts`), and the credential is minted at boot `0600` into the instance data directory (`src/dev-local-token.ts`, `CINATRA_DATA_DIR` else `.cinatra/`). An unknown peer, a missing ingress snapshot, or an unminted credential REFUSES.

`isTrustedDevPeer` and `shouldGrantDevAdminBypass` are pure helpers — keep them that way. `src/dev-admin-bypass-request.ts` is the ONE request-level composition; both consumers (`index.tsx` and `src/lib/cli-api/route-guard.ts`) call `grantDevAdminBypassForRequest` and nothing else, so the two surfaces cannot drift into two trust boundaries. On the bypass path the OAuth verify is skipped, so `bearerSignatureVerified` is false and every header-derived identity arm in `actor-identity.ts` stays shut: the caller is the anonymous local operator, never a named user. The credential header is in the MCP log redaction set (`src/lib/mcp-logging.ts`) — an enabled server log writes every request header to disk, so leaving it out would copy the `0600` credential into a plain-text file. The A2A_DEV_BYPASS org fallback (`index.tsx`) is a SEPARATE opt-in with its own switch and is untouched here.

The CLIENT half of the contract lives in `packages/cli/src/dev-local-token-client.mjs`: it locates and reads the credential file, sends it ONLY to a loopback target, and sends no forwarded header. Its suite pins the header name, the file name and the forwarded-header set to this package's exported constants, so the two halves cannot drift apart, and the round-trip suite drives the whole contract over a real loopback socket.

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
