import { defineConfig } from "vitest/config";
import * as path from "node:path";

// Minimal root-level vitest config for src/** unit tests.
// Package-scoped tests still live in each workspace package (packages/*)
// and run via their own `pnpm --filter <pkg> test`.
//
// Hosts `src/lib/__tests__/enqueue-child-flow.test.ts`, a unit test for the
// FlowProducer helper that powers orchestrator child-flow composition. bullmq
// and ioredis are mocked via `vi.mock`; no live Redis is required.

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    // Vite 8 native: read tsconfig.json `paths` so we don't have to hand-
    // mirror every workspace subpath alias in this file. Vite runs the
    // `alias` block BEFORE this (and before user plugins, even enforce:"pre"),
    // so the stubs/mocks above continue to win. Closes the recurring
    // ERR_MODULE_NOT_FOUND class for tsconfig-mapped subpaths that lacked an
    // explicit alias (objects/register-artifact-extensions, skills/store,
    // apollo-connector/log-directory, etc. — entries in tsconfig).
    tsconfigPaths: true,
    alias: [
      // Order matters — Vite's alias resolver picks the FIRST match, so
      // more-specific stubs must come before broader prefixes.
      { find: "server-only", replacement: serverOnlyStub },
      {
        find: "@/lib/database",
        replacement: path.join(__dirname, "tests/__stubs__/database.ts"),
      },
      {
        find: "@/lib/logging",
        replacement: path.join(__dirname, "tests/__stubs__/logging.ts"),
      },
      // src/__tests__/a2a-route.test.ts imports src/app/api/a2a/route.ts,
      // which imports @cinatra-ai/a2a. The real a2a barrel pulls in
      // @cinatra/agent-builder (Drizzle + pacote), so we redirect the alias
      // to a minimal stub exposing only the two symbols route.ts actually
      // needs: `toSseResponse` + type `JSONRPCResponse`.
      {
        find: "@cinatra-ai/a2a",
        replacement: path.join(__dirname, "tests/__stubs__/cinatra-a2a.ts"),
      },
      // src/__tests__/a2a-dev-auto-connect.test.ts imports from
      // @cinatra-ai/nango-connector. The real package pulls in @/lib/nango +
      // auth + DB access that the dev-auto-connect tests mock via vi.mock(),
      // so we redirect to a minimal stub.
      {
        find: "@cinatra-ai/nango-connector",
        replacement: path.join(
          __dirname,
          "tests/__stubs__/connector-nango.ts",
        ),
      },
      // src/app/settings/agents/actions.ts imports @/lib/agents-store and
      // @cinatra-ai/skills via the refresh/match flows. Those entry points
      // pull @cinatra-ai/llm and other modules that aren't
      // resolvable in the root vitest sandbox. Stub both to a minimal shape
      // the actions module loader accepts. The save-agent-install-path action
      // under test does not depend on either symbol.
      {
        find: "@/lib/agents-store",
        replacement: path.join(__dirname, "tests/__stubs__/agents-store.ts"),
      },
      {
        // Exact-match (not prefix): the bare `@cinatra-ai/skills` barrel pulls
        // @cinatra-ai/llm + heavy deps not resolvable in the root vitest
        // sandbox, so it is stubbed. But a PREFIX string match also captured
        // real subpaths like `@cinatra-ai/skills/mcp-handlers` (tsconfig maps it
        // to packages/skills/src/mcp/handlers.ts) and rewrote them to
        // `…/cinatra-skills.ts/mcp-handlers` → "Cannot find package". Anchor to
        // the bare specifier so subpaths fall through to tsconfigPaths.
        find: /^@cinatra-ai\/skills$/,
        replacement: path.join(__dirname, "tests/__stubs__/cinatra-skills.ts"),
      },
      // src/app/api/test-delivery/send/__tests__/route.test.ts imports
      // route.ts, which depends on @cinatra-ai/mcp-client and
      // @cinatra-ai/trigger-email-send. Both barrels are light leaves with no
      // heavy transitive deps, so map them straight to source.
      {
        find: "@cinatra-ai/mcp-client",
        replacement: path.join(
          __dirname,
          "packages/mcp-client/src/index.ts",
        ),
      },
      // The @cinatra-ai/artifacts barrel must resolve for the blob-store
      // tests. tsconfig has the path; vitest needs the mirrored alias to
      // close the recurring tsconfig/vitest gap.
      {
        find: "@cinatra-ai/artifacts",
        replacement: path.join(__dirname, "packages/artifacts/src/index.ts"),
      },
      // `src/app/projects/[projectId]/permissions/actions.ts` imports
      // `handlers` from `@cinatra-ai/projects` to call the `project_access_*`
      // MCP handlers in-process through the server-action wrapper. tsconfig
      // has the path alias; vitest needs the mirrored entry.
      {
        find: "@cinatra-ai/projects",
        replacement: path.join(__dirname, "packages/projects/src/index.ts"),
      },
      // `@cinatra-ai/objects/classifier-signals` is a leaf subpath. Listed
      // here so tests under `src/lib/artifacts/` (root vitest scope) can
      // import the leaf without the heavy objects barrel. tsconfig has the
      // matching path alias; this explicit alias keeps the leaf isolated.
      {
        find: "@cinatra-ai/objects/classifier-signals",
        replacement: path.join(__dirname, "packages/objects/src/classifier-signals.ts"),
      },
      {
        find: "@cinatra-ai/trigger-email-send",
        replacement: path.join(
          __dirname,
          "packages/trigger-email-send/src/index.ts",
        ),
      },
      // src/lib/__tests__/background-jobs-actor-context.test.ts imports
      // getActorContext from @cinatra-ai/llm. The actor-context
      // module is a leaf with no transitive heavy deps, so map the sub-path
      // entry directly to its source.
      // The `/actor-context` subpath must be aliased BEFORE the bare package:
      // @rollup/plugin-alias prefix-matches a string `find`, so the bare entry
      // would otherwise rewrite `@cinatra-ai/llm/actor-context`
      // to `…/actor-context.ts/actor-context` (ENOTDIR). Both map to the same leaf.
      {
        find: "@cinatra-ai/llm/actor-context",
        replacement: path.join(
          __dirname,
          "packages/llm/src/actor-context.ts",
        ),
      },
      {
        find: "@cinatra-ai/llm/anthropic-log-directory",
        replacement: path.join(
          __dirname,
          "packages/llm/src/anthropic-log-directory.ts",
        ),
      },
      {
        find: "@cinatra-ai/llm/anthropic-logging-state",
        replacement: path.join(
          __dirname,
          "packages/llm/src/anthropic-logging-state.ts",
        ),
      },
      {
        find: "@cinatra-ai/llm",
        replacement: path.join(
          __dirname,
          "packages/llm/src/actor-context.ts",
        ),
      },
      // src/app/api/llm-bridge/route.ts imports `emitUsageEvent` from
      // @cinatra-ai/metric-usage-api for the media branch. The real entry
      // point re-exports `createMetricUsageMcpModule`, which pulls
      // @cinatra-ai/mcp-server (heavy barrel, not loadable in the root vitest
      // sandbox). Stub the package surface to just the symbols the bridge
      // route references so all bridge tests can load route.ts. The
      // media-input-routing.test.ts file additionally `vi.mock`s this entry
      // to spy on emitUsageEvent payloads.
      {
        find: "@cinatra-ai/metric-usage-api",
        replacement: path.join(
          __dirname,
          "tests/__stubs__/metric-usage-api.ts",
        ),
      },
      // src/app/setup/instance-name/actions.ts imports createNpmUser + typed
      // errors from @cinatra-ai/registries. The real barrel pulls in pacote /
      // semver install transitive chains that aren't needed for the wizard
      // action unit tests. Map the entry to a narrow stub that re-exports
      // only the user-provisioning slice.
      {
        find: "@cinatra-ai/registries",
        replacement: path.join(
          __dirname,
          "tests/__stubs__/cinatra-registries.ts",
        ),
      },
      // src/app/projects/__tests__/projects-list.test.tsx imports
      // @/app/projects/page, which transitively pulls in @/lib/auth via
      // auth-session.ts. The real auth.ts imports
      // @cinatra-ai/google-oauth-connection, which chains through
      // campaigns/actions.ts → @cinatra-ai/connector-openai/actions. Stub
      // auth.ts with the minimal API auth-session.ts needs.
      {
        find: "@/lib/auth",
        replacement: path.join(__dirname, "tests/__stubs__/auth.ts"),
      },
      // The notifications package has four entry points. The test files stay
      // under src/ (root vitest's include glob only covers src/**) and import
      // these package specifiers, so map each to its package source. Listed
      // before the `@/` catch-all (first match wins). Each is its own distinct
      // sub-path alias; there is NO bare `@cinatra-ai/notifications` prefix
      // that a longer path could shadow. `/host-adapters` is the TRUE LEAF
      // the boot-reachable notifications-host.ts imports the setter from.
      {
        find: "@cinatra-ai/notifications/host-adapters",
        replacement: path.join(
          __dirname,
          "packages/notifications/src/host-adapters.ts",
        ),
      },
      {
        find: "@cinatra-ai/notifications/types",
        replacement: path.join(
          __dirname,
          "packages/notifications/src/types.ts",
        ),
      },
      {
        find: "@cinatra-ai/notifications/client",
        replacement: path.join(
          __dirname,
          "packages/notifications/src/client.ts",
        ),
      },
      {
        find: "@cinatra-ai/notifications/server",
        replacement: path.join(
          __dirname,
          "packages/notifications/src/server.ts",
        ),
      },
      // Sentry is exposed through split entry points. The two sentry test
      // files stay under src/ (root vitest include) and import these
      // specifiers. The longer `/server` sub-path is listed BEFORE the bare
      // `@cinatra-ai/errors` so first-match-wins resolves correctly. Listed
      // before the `@/` catch-all.
      {
        find: "@cinatra-ai/errors/server",
        replacement: path.join(
          __dirname,
          "packages/errors/src/server.ts",
        ),
      },
      {
        find: "@cinatra-ai/errors",
        replacement: path.join(__dirname, "packages/errors/src/index.ts"),
      },
      // src/app/settings/__tests__/page-tile.test.tsx imports
      // src/app/settings/page.tsx, which uses `@/components/*`. A general
      // `@/` → `src/` fallback lets vitest resolve component imports without
      // adding per-import stubs. Specific `@/lib/*` stubs above still take
      // precedence.
      { find: /^@\/(.+)$/, replacement: path.join(__dirname, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
    // The wholesale `pnpm test:root` runs the entire root include (~4200 tests /
    // ~400 files) in one process. Several guards are repo-wide source scanners
    // (e.g. toast-import-guard) whose filesystem walk gets starved under that
    // load on a constrained CI runner and trips the 5s vitest default. 30s gives
    // those scanners headroom without masking a genuinely hung unit test.
    testTimeout: 30_000,
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      "src/components/**/*.test.{ts,tsx}",
      "src/app/configuration/permissions/**/*.test.{ts,tsx}",
      "scripts/audit/__tests__/**/*.test.{ts,mjs}",
      // Vendor Anthropic skills fetcher safety tests (spawn-based; no network;
      // CI-postinstall env safety).
      "scripts/__tests__/**/*.test.{ts,mjs}",
      // CLI dev-marketplace plugin sync (dependency-injected git; no real git).
      "packages/cli/src/__tests__/**/*.test.{ts,mjs}",
      // SDK ABI contract: dependency-normalization shim (pure; no IO).
      "packages/sdk-extensions/src/**/__tests__/**/*.test.{ts,tsx}",
      // SDK Nango connect surfaces: orphaned Connect UI cleanup contract (#48)
      // (source-text + module-load smoke; vitest env is node — no DOM render).
      "packages/sdk-ui/src/**/__tests__/**/*.test.{ts,tsx}",
      // Extension inventory + dependency-graph generator (pure; reads repo).
      "scripts/extensions/__tests__/**/*.test.{ts,mjs}",
      // Generic WordPress blog-connector binding migration (pure; no DB).
      "scripts/signing/__tests__/**/*.test.{ts,mjs}",
    ],
    // The wholesale root suite (`pnpm test:root`) runs every `include` glob.
    // The exclusions below are the STABILIZED-set carve-outs — each one is a
    // structurally-out-of-scope tier or a quarantined sandbox gap, and each
    // carries an inline reason below. Anything NOT excluded here
    // must run and pass; new `src/**/__tests__` files are gated by default.
    exclude: [
      "**/node_modules/**",
      "**/*.integration.test.ts",
      // node:test runner files (vitest reports "No test suite found"); each is
      // run via `node --test` by its own dedicated workflow or step
      // (gatekept-install-no-direct-registry, actions-pin-gate,
      // workspace-phantom-deps, crm-pointer-gate, schema-migration-gate),
      // NOT as vitest tests.
      "scripts/audit/__tests__/gatekept-install-no-direct-registry.test.mjs",
      "scripts/audit/__tests__/actions-pinned-gate.test.mjs",
      "scripts/audit/__tests__/workspace-phantom-deps.test.mjs",
      "scripts/audit/__tests__/manifest-resolve.test.mjs",
      "scripts/audit/__tests__/crm-pointer-gate.test.mjs",
      "scripts/audit/__tests__/schema-migration-gate.test.mjs",
      // DB-integration tier: needs a live Postgres (ECONNREFUSED 5432 in the
      // unit sandbox; the perpetual-loops-invariants CI job has no DB service).
      // Mirrors the `*.integration.test.ts` exclusion above.
      "src/lib/__tests__/integration/**",
      // QUARANTINE (sandbox gap): brittle `(\w+)\(\)`
      // scanner regex matches `resolveExtensionActorSummary()`; ungated in CI.
      "src/__tests__/mcp-server-tool-count.test.ts",
    ],
    env: {
      SUPABASE_DB_URL:
        process.env.SUPABASE_DB_URL ??
        "postgres://unused:unused@localhost:5432/unused",
      // rename-vendor-action.test.ts uses the real instance-secrets module
      // (no vi.mock for it), so encryptSecret needs a valid 32-byte key.
      // 64 hex chars = 32 bytes. Tests that want to assert the missing-key
      // branch can `delete process.env.CINATRA_ENCRYPTION_KEY` in their own
      // beforeEach. CINATRA_ENCRYPTION_KEY is the canonical encryption-key
      // env var.
      CINATRA_ENCRYPTION_KEY:
        process.env.CINATRA_ENCRYPTION_KEY ??
        "0".repeat(64),
    },
  },
});
