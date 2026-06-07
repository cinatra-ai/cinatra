# @cinatra-ai/sdk-extensions

The Cinatra extension SDK — the **frozen author-facing ABI** every Cinatra
extension (agent, connector, skill, artifact, workflow) builds against.

It is intentionally a leaf, host-agnostic contract package: an extension
peer-depends on `react` / `next` / `@cinatra-ai/sdk-*` only and reaches every
privileged host capability through the injected `ctx` ports — never via a
`@/lib/*`, `@/components/*`, or `@/app/*` import.

## What it provides

- **`register(ctx)` host-port surface** (`ExtensionHostContext`) — the privileged
  ports the host injects at activation: `db`, `settings`, `secrets`, `nango`,
  `authSession`, `mcp`, `objects`, `jobs`, `notifications`, `ui`, `logger`,
  `runtime`, `capabilities`, and `telemetry`.
- **Manifest + dependency contracts** — the `cinatra.*` package-manifest shape,
  the dependency-graph types, and the package-export contract.
- **Loader / registry types** — the shared activation driver and ABI-range check.

## ABI version

The SDK ABI is **`2.0.0`** (`SDK_EXTENSIONS_ABI_VERSION`). The MAJOR bumps on any
breaking change to the author-facing contract (ports, lifecycle, manifest
fields). `2.0.0` added the `telemetry` host port for metered connectors.

Server-entry extensions pin a compatible range via `cinatra.sdkAbiRange`
(e.g. `"^2"`); the loader refuses to activate an extension whose declared range
the host ABI does not satisfy.

## Allowed first-party dependencies

A Cinatra extension's only permitted `@cinatra-ai/*` **code** dependencies are
the SDK packages: this package and `@cinatra-ai/sdk-ui` (visual primitives).
Everything else is reached through a `ctx` port.
