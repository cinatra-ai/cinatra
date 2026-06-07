# @cinatra-ai/marketplace-mcp-client

Typed MCP client for calling the Cinatra Marketplace primitives from Cinatra-side code (sync worker, integration UI, deep-link consumer).

## Why this package exists

`@cinatra-ai/marketplace-mcp-contract` (in the `marketplace` repo) is the **single source of truth** for the Marketplace MCP primitive shapes. But until that package is publishable to `registry.cinatra.ai`, the Cinatra-side code can't `import` from it directly.

This package vendors the TS types (no Zod runtime — just shapes) so Cinatra-side sync worker + UI can land NOW with the correct contract. The swap to `@cinatra-ai/marketplace-mcp-contract` is a one-line import change at every call site once the contract package is reachable from the registry.

See `src/types.ts` for the vendoring boundary — every type carries a comment pointing at the source-of-truth file.

## What it ships

| File | What |
|---|---|
| `src/types.ts` | Vendored TS types — extension / vendor / package / self-service shapes |
| `src/client.ts` | **Pure** (no `server-only`, no MCP SDK): `MarketplaceMcpClient` interface + `MarketplaceMcpError` + `createMockMarketplaceMcpClient(fixtures)`. Safe to import anywhere. |
| `src/http-client.ts` | **Server-only**: the real `createHttpMarketplaceMcpClient(opts)` — speaks MCP (SDK `Client` + `StreamableHTTPClientTransport`) against `/wp-json/cinatra/mcp`. Reached via the `@cinatra-ai/marketplace-mcp-client/http-client` sub-entry. |
| `src/index.ts` | Re-exports the PURE surface only (types + interface + mock + error). |

### Transport + URL

The marketplace exposes its abilities only via the wordpress/mcp-adapter at
`/wp-json/cinatra/mcp` (NOT per-primitive REST routes). The WP **ability id** is
`cinatra/<kebab>` (e.g. `cinatra/vendor-register-self`), but MCP tool names
cannot contain `/`, so the adapter's `McpNameSanitizer` flattens `/`→`-` and the
**over-the-wire tool name is `cinatra-<kebab>`** (e.g.
`cinatra-vendor-register-self`). Always build the wire name via `mcpToolName()`
in `http-client.ts` — calling the slash form fails with `Tool not found`.

The base URL is **hardcoded** (`https://marketplace.cinatra.ai`) — there is one
marketplace and it is not operator-configurable. `MARKETPLACE_BASE_URL` (or the
`baseUrl` option) is honored ONLY outside production (local dev / CI). Auth: a
raw `token` is sent as `Bearer <token>`; a value already carrying a scheme
(`Basic ...` — WP Application Passwords) passes through unchanged.

### Methods

Vendor self-service (backed by live extender abilities):
- `vendorRegisterSelf` — free vendor self-registration + namespace reservation
- `vendorGetSelf` — the calling instance's own vendor status
- `vendorProfileVisibilitySet` — private↔public profile toggle
- `vendorRegistryTokenRotateSelf` — self-service registry token rotation

Other:
- `vendorApply` — invite/commercial application (`cinatra/vendor-apply`)
- `packageSyncFromRegistry` — sync worker (`cinatra/registry-sync-package`)
- `extensionGet` / `vendorGet` — NOT yet served (no backing ability; reject with
  a 501 `MarketplaceMcpError` until the catalog/submission phases land)

## Usage

```ts
// Real client — SERVER-ONLY; import from the /http-client sub-entry.
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

// URL is hardcoded; only the per-instance MCP-call credential is passed.
const client = createHttpMarketplaceMcpClient({ token: process.env.MARKETPLACE_INSTANCE_TOKEN });

const result = await client.vendorGetSelf();
```

For tests + dev (no live backend), import the pure mock from the package index:

```ts
import { createMockMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client";

const client = createMockMarketplaceMcpClient({
  self: { vendor_id: 1, namespace: "@acme", state: "active" },
  onSync: (input) => console.log("sync called", input.metadata.packageName),
});
```
