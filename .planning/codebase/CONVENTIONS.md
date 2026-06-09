# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- Route handlers: `route.ts` inside Next.js App Router segments, e.g. `src/app/api/a2a/route.ts`
- Library modules: `kebab-case.ts`, e.g. `src/lib/auth-route-guard.ts`, `src/lib/scope-filter.ts`
- Test files: `*.test.ts` or `*.test.tsx`, co-located next to the source file or inside `__tests__/` subdirectories
- Component files: `kebab-case.tsx`, e.g. `src/components/scope-badge.tsx`, `src/components/visibility-badge.tsx`
- Stub/mock files: descriptive `kebab-case.ts` under `tests/__stubs__/`, e.g. `tests/__stubs__/database.ts`

**Functions:**
- camelCase for all exported functions: `evaluateSkillMatchRules`, `buildWorkflowAgentTaskExecutor`, `resolveAgentRunMcpActor`
- Async functions suffixed with no special marker; `async function` keyword used directly
- Server action helpers often prefixed with verb: `createAgentTemplate`, `readAgentTemplates`, `updateAgentRunStatus`

**Variables:**
- camelCase for local and exported constants: `serverOnlyStub`, `connectionString`
- SCREAMING_SNAKE_CASE for module-level constant identifiers that represent environment/directory paths: `APOLLO_API_LOG_DIRECTORY`, `CINATRA_ENCRYPTION_KEY`, `PUBLIC_PATH_PREFIXES`
- React state variables follow `[value, setValue]` convention (standard hooks)

**Types:**
- PascalCase for interfaces, types, and enums: `DependencyTree`, `ResolvedNode`, `ScopeToken`, `PersistedSkill`
- Type-only imports use `import type { ... }` syntax (enforced by ESLint for connector packages)

## Code Style

**Formatting:**
- No `.prettierrc` detected; formatting is not explicitly configured via a Prettier config file
- ESLint 10 flat config via `eslint.config.mjs` using `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`
- React version pinned explicitly to `19.2.5` in ESLint settings to avoid ESLint 10 API breakage

**Linting:**
- Tool: ESLint 10 with flat config (`eslint.config.mjs`)
- Run command: `pnpm lint` (maps to `eslint` with no flags)
- Key enforced rules:
  - `no-restricted-imports` — 4-layer import boundary system for `drizzle-cube`, `sdk-dashboard`, and connector packages (see `eslint.config.mjs`)
  - `@typescript-eslint/consistent-type-imports` — enforced in connector packages: `prefer: "type-imports"`, `fixStyle: "separate-type-imports"`
- TypeScript: strict mode enabled (`"strict": true` in `tsconfig.json`), `target: ES2017`, `module: esnext`

## Import Organization

**Order (observed pattern in source files):**
1. Node built-in modules (`node:fs`, `node:path`)
2. Framework imports (`next/server`, `react`)
3. External package imports (`better-auth/cookies`, `@playwright/test`)
4. Internal workspace package imports (`@cinatra-ai/*`)
5. App-local path alias imports (`@/*`)
6. Relative imports

**Path Aliases:**
- `@/*` → `src/` (app-local source)
- `@cinatra-ai/*` → workspace packages under `packages/` (mapped via `tsconfig.json` paths + vitest aliases)
- Subpath aliases are extensive: `@cinatra-ai/extensions/runtime-discovery`, `@cinatra-ai/llm/actor-context`, `@cinatra-ai/skills/mcp-handlers`, etc.

## Error Handling

**Patterns:**
- Server Route Handlers return structured responses with HTTP status codes (e.g. `404` when feature flag is off, `401` for auth failures)
- `try/catch/finally` with explicit `.catch(() => {})` on cleanup in integration code (seen in `tests/e2e/agents-run/agents-run.spec.ts`)
- Result discriminants used: `{ kind: "ok", ... }` and `{ kind: "error", ... }` shapes for actor context resolution
- DB calls and external service calls wrapped in try/catch; connection timeout set explicitly (e.g. `connectionTimeoutMillis: 3_000`)

## Logging

**Framework:** File-based API logging for LLM connectors (log directories per connector). No universal application logger — logging appears to be environment/connector-specific.

**Patterns:**
- Log directories defined as module constants imported from leaf subpaths to avoid circular ESM deps (e.g. `@cinatra-ai/llm/anthropic-log-directory`)
- In tests, logging is stubbed via `tests/__stubs__/logging.ts`
- Console logging avoided in library code; file-based logging preferred for LLM API calls

## Comments

**When to Comment:**
- Block comments at the top of route files explain auth model, feature flags, and design decisions
- Inline comments annotate non-obvious behavior and intentional deviations: `// intentional so production deployments have to opt in`
- `// TODO(label):` format with optional parenthetical label for tracking: `TODO(marketplace-terms-fetch)`, `TODO(hardening)`, `TODO(live integration)`
- `//` line comments inside `vitest.config.ts` for every alias explaining WHY a stub exists

**JSDoc/TSDoc:**
- JSDoc block comments (`/** ... */`) used on test files and test functions to document intent, coverage scope, and non-obvious skip logic
- Not uniformly applied to library exports; used selectively where behavior is complex

## Function Design

**Size:** Functions tend to be focused; route handlers are larger (50–200 lines) but are documented with a leading block comment explaining the full contract

**Parameters:** Plain object parameters (`input: { ... }`) preferred for functions with multiple related args (e.g. `resolveAgentRunMcpActor(input: { ... })`)

**Return Values:** Discriminated union returns (`{ kind: "ok" | "error", ... }`) used for fallible operations. Async functions return `Promise<T>` explicitly in signatures.

## Module Design

**Exports:** Named exports preferred; barrel `index.ts` files used in packages; `export *` used in package barrels

**Barrel Files:** Each workspace package exposes a root `src/index.ts` barrel. Subpath exports used for tree-shaking and to avoid circular deps (e.g. `packages/errors/src/server.ts`, `packages/errors/src/index.ts`)

**Server-only Guard:** Modules that must not run in the browser import `"server-only"` as the first import; this is a hard contract enforced via the test stub at `tests/__stubs__/server-only.ts`

---

*Convention analysis: 2026-06-09*
