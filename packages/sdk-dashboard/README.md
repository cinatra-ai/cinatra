# @cinatra-ai/sdk-dashboard

Generic, extraction-ready dashboards SDK. Owns the Cinatra anti-corruption layer around `drizzle-cube/server`, the shadcn-built UI primitives consumers compose into dashboards, and the AI portlet contract.

## Boundary rule

This package **must not** import:

- `@/*` (Cinatra app source)
- `@cinatra/*` (other Cinatra packages)
- `better-auth` (auth is host-provided via context)
- `bullmq` (job orchestration is host-provided)
- `drizzle-cube/client/*` and drizzle-cube's built-in AI surface — these violate the consuming app's "no exceptions" shadcn-admin UI rule and the centralized LLM orchestration rule.
- `drizzle-cube/mcp` is allowed ONLY inside `src/adapters/drizzle-cube/`. The `mcp-tools.ts` wrapper hosts the bridge between drizzle-cube's native `getCubeTools` and Cinatra's MCP server registry; consumers (`packages/dashboards/src/mcp-cubes/`) never see drizzle-cube types.

The only place inside this package where `drizzle-cube/*` imports are allowed is `src/adapters/drizzle-cube/`. Enforced by ESLint `no-restricted-imports` with regression tests under `src/__tests__/eslint-boundary.test.ts`.

All boundaries are enforced by ESLint. The package follows a headless-server boundary so host apps own app-level wiring while this SDK stays extraction-ready.

## Subpath layout

```
src/
  types/                   — Cinatra DTOs (CubeDescriptor, QuerySpec, QueryResult, SecurityContext)
  adapters/
    drizzle-cube/          — the ONLY drizzle-cube/* import site in the repo
  hooks/                   — useCubeQuery, useCubeMeta
  components/              — shadcn-built portlet primitives
  ai/                      — Cinatra portlet JSON contract + validators
  cube-ir/                 — restricted cube IR + compiler + validator
```

## Extraction trajectory

Structured for eventual extraction as a standalone OSS package. Apache-2.0 licensed from day one. Until extraction, lives inside the Cinatra monorepo as a workspace package.
