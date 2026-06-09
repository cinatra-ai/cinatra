# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (root-level config: `vitest.config.ts`) — used for all unit and audit tests
- Playwright — used for E2E tests (multiple configs under `tests/e2e/config/`)
- Node built-in test runner (`node --test`) — used for supply-chain/security audit gates that must have zero install dependencies

**Assertion Library:**
- Vitest: `expect` from `vitest` (Jest-compatible API)
- Node test runner: `node:assert/strict`
- Playwright: `expect` from `@playwright/test`

**Run Commands:**
```bash
pnpm test:root                          # Run all root-level unit tests (vitest)
pnpm test:e2e:agents-run                # E2E: agent run workflows (Playwright)
pnpm test:e2e:rbac                      # E2E: RBAC authorization (Playwright)
pnpm test:e2e:dashboards                # E2E: dashboards (Playwright)
pnpm test:e2e:notifications             # E2E: notifications (Playwright)
pnpm test:e2e:workflows                 # E2E: workflows (Playwright)
pnpm test:e2e:wp-drupal                 # E2E: WordPress/Drupal UAT (Playwright)
pnpm test:e2e:design                    # E2E: design fixtures/snapshots (Playwright)
pnpm test:e2e:design:update             # Update design snapshots (Playwright)
pnpm test:e2e:render-smoke              # E2E: render smoke (Playwright)
node --test scripts/audit/__tests__/actions-pinned-gate.test.mjs  # Node runner gate
```

## Test File Organization

**Location:**
- Unit tests: `src/**/__tests__/**/*.test.{ts,tsx}` — inside `__tests__/` subdirectory next to source
- Component tests: `src/components/**/*.test.{ts,tsx}` — co-located with component file
- Script audit tests: `scripts/audit/__tests__/**/*.test.{ts,mjs}`
- Script utility tests: `scripts/__tests__/**/*.test.{ts,mjs}` and `scripts/lib/__tests__/`
- Package unit tests: `packages/<name>/src/**/__tests__/**/*.test.{ts,tsx}` — each package has its own vitest config
- Integration tests: `packages/registries/tests/*.integration.test.ts` (excluded from root vitest run)
- Contract tests: `tests/contracts/**/*.test.{ts,mts}`
- E2E tests: `tests/e2e/<suite>/*.spec.ts`
- Stubs: `tests/__stubs__/*.ts` — module alias stubs used globally in root vitest

**Naming:**
- Unit/audit files: `*.test.ts`, `*.test.tsx`, `*.test.mjs`
- E2E files: `*.spec.ts`
- Integration files: `*.integration.test.ts`

**Structure:**
```
src/
  __tests__/              # Route-level and integration unit tests
    a2a-route.test.ts
    hitl-assist-multi-turn.test.ts
    ...
  components/
    scope-badge.tsx
    scope-badge.test.tsx  # Co-located component test
  app/configuration/permissions/**/*.test.{ts,tsx}

packages/<name>/
  src/__tests__/          # Package-scoped unit tests
  tests/                  # (registries) integration + standalone tests
  vitest.config.ts        # Per-package vitest config

scripts/
  audit/__tests__/        # Audit gate tests (vitest + node --test)
  __tests__/              # Script utility tests
  lib/__tests__/

tests/
  __stubs__/              # Module-level alias stubs for root vitest
  contracts/              # Cross-service contract tests
  e2e/<suite>/            # Playwright E2E suites
    config/               # Playwright config per suite
```

## Test Structure

**Suite Organization:**
```typescript
// Standard vitest unit test pattern
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("FeatureName - scenario group", () => {
  beforeEach(() => {
    mockFn.mockReset();
  });

  it("describes expected behavior", async () => {
    // arrange
    mockFn.mockResolvedValue({ kind: "ok", ... });
    // act
    const result = await functionUnderTest(input);
    // assert
    expect(result).toEqual(expected);
  });
});
```

**Patterns:**
- `beforeEach` used to reset all vi mocks before each test
- `afterEach` used to restore environment variables (e.g. `process.env.CINATRA_A2A_HTTP_ENABLED`)
- Test descriptions follow "behavior under condition" naming: `"POST /api/a2a"`, `"evaluateSkillMatchRules - declarative rules"`

## Mocking

**Framework:** Vitest (`vi` from `vitest`)

**Patterns:**
```typescript
// vi.hoisted() for shared mock functions that factory closures need
const { mockFnA, mockFnB } = vi.hoisted(() => ({
  mockFnA: vi.fn(),
  mockFnB: vi.fn(),
}));

// vi.mock() at module scope — hoisted automatically
vi.mock("@/lib/a2a-auth", () => ({
  verifyA2AAccessToken: verifyA2AAccessTokenMock,
}));

// server-only stub — always mock to prevent SSR import failures
vi.mock("server-only", () => ({}));

// Import AFTER mocks are registered
import { POST, OPTIONS } from "../app/api/a2a/route";
```

**Alias-based stubbing (vitest.config.ts):**
Rather than per-test `vi.mock()`, heavy dependencies with DB/auth/Redis transitive deps are redirected globally via Vite alias in `vitest.config.ts`:
- `tests/__stubs__/database.ts` — stubs `@/lib/database`
- `tests/__stubs__/logging.ts` — stubs `@/lib/logging`
- `tests/__stubs__/server-only.ts` — stubs `server-only`
- `tests/__stubs__/cinatra-a2a.ts` — stubs `@cinatra-ai/a2a`
- `tests/__stubs__/agents-store.ts` — stubs `@/lib/agents-store`
- `tests/__stubs__/cinatra-skills.ts` — stubs bare `@cinatra-ai/skills` (regex anchor to avoid subpath capture)
- `tests/__stubs__/auth.ts`, `tests/__stubs__/service-accounts.ts`, etc.

**What to Mock:**
- All DB access (`@/lib/database`)
- Auth library (`@/lib/a2a-auth`, `@/lib/auth-route-guard`)
- Heavy transitive deps that pull Drizzle/pacote/Redis (stub via alias)
- `server-only` (prevents SSR crash in test environment)

**What NOT to Mock:**
- Pure logic modules (matching, serialization, dependency resolution)
- Leaf subpath imports that have no side effects
- Package-scoped unit tests that test only their own source

## Fixtures and Factories

**Test Data:**
```typescript
// Factory function pattern (from packages/registries tests)
function node(name: string, version = "1.0.0"): ResolvedNode {
  return {
    packageName: name,
    resolvedVersion: version,
    tarballUrl: `https://reg.test/${name}.tgz`,
    integrity: `sha512-${name}`,
    requestedRange: "^1.0.0",
    dependencies: {},
  };
}

// Minimal shape builder for unit isolation (from packages/skills tests)
function buildSkill(content: string): PersistedSkill {
  return { id: "x", name: "x", slug: "x", description: "", content, ... } as PersistedSkill;
}
```

**E2E Fixtures:**
- `tests/e2e/agents-run/fixtures.ts` — Playwright fixture definitions
- `tests/e2e/agents-run/seed.ts` — DB seed helpers for test isolation
- `tests/e2e/design/design-fixtures.spec.ts` — visual snapshot fixtures
- `tests/e2e/agents-run/run-batched.sh` / `run-batched-trackb.sh` — batch run scripts

**Location:**
- Unit stubs: `tests/__stubs__/`
- E2E fixtures/seed: `tests/e2e/<suite>/fixtures.ts`, `tests/e2e/<suite>/seed.ts`
- E2E auth setup: `tests/e2e/<suite>/auth.setup.ts`

## Coverage

**Requirements:** No coverage thresholds enforced. `pnpm test:root` runs with `--no-coverage` flag explicitly.

**View Coverage:** Not configured as a standard command. Coverage reporting is not part of the CI gate setup visible in the config.

## Test Types

**Unit Tests:**
- Vitest, no live services required
- Stubs/mocks for all IO: DB, auth, Redis, LLM connectors
- Scope: individual functions, route handler branches, skill matching logic, serialization
- Location: `src/**/__tests__/`, `packages/*/src/__tests__/`, `scripts/audit/__tests__/`

**Integration Tests:**
- File suffix: `*.integration.test.ts`
- Require live Postgres (`SUPABASE_DB_URL`, port 5432)
- Excluded from root `pnpm test:root` run; must be run separately
- Location: `packages/registries/tests/*.integration.test.ts`, `src/lib/__tests__/integration/`

**Contract Tests:**
- Framework: Vitest
- Scope: WordPress/Drupal plugin ↔ core schema/fixture conformance; no live services
- Location: `tests/contracts/wp-drupal/contract-v1.test.ts`

**E2E Tests:**
- Framework: Playwright
- Multiple suites, each with its own config under `tests/e2e/config/`
- Suites: `agents-run`, `rbac`, `dashboards`, `notifications`, `workflows`, `wp-drupal`, `design`, `render-smoke`
- Require live app on localhost (default port 3000 for agents-run, 3100 for dashboards)
- `retries: 1` in CI, `retries: 0` locally
- Per-test timeout: 180s for agent runs (real WayFlow + LLM bridge calls)
- Auth setup projects run before test projects (`auth.setup.ts`, `auth.customer.setup.ts`)

**Audit/Gate Tests (Node runner):**
- Framework: `node:test` + `node:assert/strict` — zero install dependencies
- Purpose: supply-chain hardening (SHA-pin format, banned imports, workspace phantom deps)
- Files: `scripts/audit/__tests__/actions-pinned-gate.test.mjs`, `scripts/audit/__tests__/gatekept-install-no-direct-registry.test.mjs`, `scripts/audit/__tests__/workspace-phantom-deps.test.mjs`
- These are excluded from vitest and run via `node --test` in dedicated CI jobs

## Common Patterns

**Async Testing:**
```typescript
it("resolves with expected shape", async () => {
  mockFn.mockResolvedValue({ kind: "ok", actorContext: { ... } });
  const result = await functionUnderTest(request);
  expect(result.status).toBe(200);
});
```

**Error Testing:**
```typescript
it("returns 404 when feature flag is unset", async () => {
  delete process.env.CINATRA_A2A_HTTP_ENABLED;
  const response = await POST(request);
  expect(response.status).toBe(404);
});
```

**Static Source Inspection (contract tests):**
```typescript
// When DOM/runtime testing is heavy, some tests read source as a string
const src = readFileSync(path.join(__dirname, "scope-badge.tsx"), "utf8");
expect(src).toMatch(/export function ScopeBadge/);
expect(src).toMatch(/from "class-variance-authority"/);
```

**Environment Variable Management:**
```typescript
// Save/restore env vars across tests
const originalFlag = process.env.CINATRA_A2A_HTTP_ENABLED;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.CINATRA_A2A_HTTP_ENABLED;
  else process.env.CINATRA_A2A_HTTP_ENABLED = originalFlag;
});
```

**E2E DB Reads:**
```typescript
// E2E tests read directly from Postgres for fixture setup and assertions
const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
try {
  await client.connect();
  const res = await client.query(`SELECT ...`);
  return res.rows[0]?.url;
} catch {
  return null;
} finally {
  await client.end().catch(() => {});
}
```

---

*Testing analysis: 2026-06-09*
