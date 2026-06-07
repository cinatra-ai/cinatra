# @cinatra-ai/connectors-catalog

A CLI-safe, dependency-free catalog of the built-in connector descriptors. It holds pure data only — package id, URL slug, display name, default visibility, and the MCP primitive prefixes used to infer which connector an agent depends on. Because it has no imports, it can be loaded from plain Node (the CLI) and from the host server registry alike; readiness probes and setup-page loaders are attached server-side, not here.

## Public API

`@cinatra-ai/connectors-catalog` / `@cinatra-ai/connectors-catalog/descriptors.mjs`

- `CONNECTOR_DESCRIPTORS` — the descriptor array (pure data)
- `listConnectorDescriptors()` — returns a defensive copy of all descriptors
- `getConnectorDescriptorByPackageId(packageId)` — lookup by npm package id
- `getConnectorDescriptorBySlug(slug)` — lookup by URL slug

`@cinatra-ai/connectors-catalog/overrides.mjs`

- `PRIMITIVE_TO_CONNECTOR_OVERRIDES` — facade primitive → provider package id
- `lookupPrimitiveOverride(primitiveName)` — resolve a facade primitive to its provider

A `ConnectorDescriptor` carries `packageId`, `slug`, `displayName`, `defaultVisibility` (`"admin" | "workspace"`), `mcpPrimitivePrefixes`, and `setupSubroute`.

## Usage

```ts
import {
  listConnectorDescriptors,
  getConnectorDescriptorBySlug,
} from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { lookupPrimitiveOverride } from "@cinatra-ai/connectors-catalog/overrides.mjs";

const all = listConnectorDescriptors();
const gmail = getConnectorDescriptorBySlug("gmail-connector");
const provider = lookupPrimitiveOverride("email_send");
```

## Docs

See https://docs.cinatra.ai
