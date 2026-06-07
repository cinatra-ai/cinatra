# @cinatra-ai/mcp-server

Mountable MCP (Model Context Protocol) server for the Cinatra app. It wires the
Streamable HTTP transport, OAuth 2.0 authorization (via Better Auth), and the
administration UI used to manage the public base URL, OAuth clients, and LLM
provider access.

## Public API

- `createMcpServerMount(options)` — builds the route handlers and admin pages; returns `TransportHandlers`, OAuth metadata handlers, connectivity-check handlers, and React pages (`OverviewPage`, `AuthPage`, `ClientsPage`, `ConsentPage`, ...).
- `createMcpServerAuthPlugins(options)` — resolves audiences/scopes, then builds the Better Auth plugin pair.
- `buildMcpAuthPlugins(options)` — pure `[jwt(), oauthProvider({...})]` builder (no app graph).
- `DEFAULT_MCP_SCOPES` — default OAuth scopes advertised by the server.
- `mcpRequestContextStorage` — `AsyncLocalStorage` carrying per-request actor/run context to tool handlers.
- `isDelegatedChatMcpToolAllowed(name)` — delegated-chat tool allowlist predicate.
- Types: `CreateMcpServerMountOptions`, `CreateMcpServerAuthPluginsOptions`, `McpServerSettings`, `McpRuntimeToolServer`, `McpRequestContext`, `DelegatedMcpActor`, `ScreenDescriptor`, `NavigationTarget`, `McpAuthPlugins`, `McpAuthPluginsOptions`.

### Sub-entry points

- `@cinatra-ai/mcp-server/auth-plugins` — pure, app-graph-free auth-plugin builder (`buildMcpAuthPlugins`, `DEFAULT_MCP_SCOPES`, and related types).

## Usage

```ts
import { createMcpServerMount } from "@cinatra-ai/mcp-server";

const mount = createMcpServerMount({
  auth,
  getSession,
  registerCapabilities: (server) => {
    /* register tools, resources, prompts, screens */
  },
});

export const { GET, POST, DELETE, OPTIONS } = mount.TransportHandlers;
```

## Docs

See https://docs.cinatra.ai
