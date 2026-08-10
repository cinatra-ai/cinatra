import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2578 — DEDICATED config for the REAL-LEDGER accounting tier.
//
// WHY A SEPARATE CONFIG. Every existing usage test mocks either
// `emitUsageEvent` or `insertUsageEvent`, and the root config *stubs*
// `@cinatra-ai/metric-usage-api` with a NO-OP emitter. That is exactly the blind
// spot that let cinatra#2578 happen: the ~10x under-report was a row the
// DATABASE discarded (`onConflictDoNothing(idempotency_key)` against a reused
// key), which no mocked store can observe. This tier therefore runs the seam,
// the subscriber, the pricing and the table for REAL, against the shared verify
// Postgres, and mocks only the provider/network/auth edges a real key would
// otherwise be needed for.
//
// It does NOT inherit the root config: the root's stub set is what has to be
// undone here, so the alias list is stated explicitly instead.
const root = __dirname;

export default defineConfig({
  resolve: {
    // Resolves `@/*` and every `@cinatra-ai/*` workspace specifier to REAL source.
    tsconfigPaths: true,
    alias: [
      // Order matters — Vite picks the FIRST match.
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      {
        // The REAL bus, reached without the package barrel.
        //
        // `@cinatra-ai/metric-usage-api`'s entry re-exports
        // `createMetricUsageMcpModule`, which pulls the whole `@cinatra-ai/mcp-server`
        // barrel into a test process that has no use for it. Its usage exports
        // are pure re-exports of `@cinatra-ai/metric-contracts`, so pointing at
        // metric-contracts yields the IDENTICAL emitter — the same
        // globalThis-pinned EventEmitter the subscriber listens on. This is a
        // module-graph shortcut, not a substitute: nothing about emit or
        // subscribe behaviour changes.
        find: /^@cinatra-ai\/metric-usage-api$/,
        replacement: path.join(root, "packages/metric-contracts/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // Real pg round trips per assertion, plus a schema clone in beforeAll.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/__tests__/integration/usage-ledger-capture.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    // SUPABASE_DB_URL / SUPABASE_SCHEMA flow through from the runner's process
    // env. `packages/metric-cost-api/src/schema.ts` reads SUPABASE_SCHEMA at
    // MODULE LOAD, so the lane schema has to be in the environment before the
    // test file imports it — which is why it is not set from inside the suite.
    env: {
      // Set ONLY here. The suite skips without a live database (a DB-integration
      // tier must not red an ordinary unit run), and a suite whose only failure
      // mode is "skipped" reports success by doing nothing. This flag says "you
      // are in the lane that exists to run it", which turns a missing database
      // from a silent skip into a hard, self-describing failure.
      CINATRA_USAGE_LEDGER_REALDB: "1",
    },
  },
});
