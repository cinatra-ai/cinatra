import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2669 — DEDICATED config for the UNKNOWN-COST AGGREGATION tier.
//
// WHY A SEPARATE CONFIG. The claim under test is a property of SQL: whether
// `SUM` returns NULL or a coalesced 0, whether `COUNT(col)` skips an outer
// join's fabricated rows where `COUNT(*)` would not, and whether the cube's
// measures survive Postgres' no-nested-aggregate rule. A mocked `db.execute`
// can assert query TEXT and nothing else, and the ROOT config additionally
// replaces `@cinatra-ai/metric-usage-api` with a NO-OP emitter, so no row would
// ever reach a table. This tier therefore runs the seam's emitter, the bus, the
// real pricing subscriber, the real store queries and the real cube SQL against
// the verify Postgres, mocking nothing on the read path.
//
// It does NOT inherit the root config — the root's stub set is exactly what has
// to be undone here — so the alias list is stated explicitly, mirroring the
// cinatra#2578 ledger tier.
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
        // `createMetricUsageMcpModule`, which pulls the whole
        // `@cinatra-ai/mcp-server` barrel into a test process that has no use
        // for it. Its usage exports are pure re-exports of
        // `@cinatra-ai/metric-contracts`, so pointing at metric-contracts
        // yields the IDENTICAL emitter — the same globalThis-pinned
        // EventEmitter the subscriber listens on. A module-graph shortcut, not
        // a substitute.
        find: /^@cinatra-ai\/metric-usage-api$/,
        replacement: path.join(root, "packages/metric-contracts/src/index.ts"),
      },
      {
        // `drizzle-cube` is a dependency of `packages/sdk-dashboard`, not of the
        // root, so a root-level runner resolves neither it nor the transitive
        // import inside the adapter this suite goes through. pnpm links the
        // package into the owning workspace at a stable path; point at its own
        // published ESM entries rather than adding a root dependency (and a
        // lockfile change) for one test process. The suite itself never names
        // `drizzle-cube` — that import is the adapter's, and the adapter
        // directory is the only place in the repo allowed to make it.
        find: /^drizzle-cube\/server$/,
        replacement: path.join(
          root,
          "packages/sdk-dashboard/node_modules/drizzle-cube/dist/server/index.js",
        ),
      },
      {
        // Same reason; the adapter barrel also re-exports the MCP bridge, and
        // this subpath is NOT `dist/mcp/*` (see the package's export map).
        find: /^drizzle-cube\/mcp$/,
        replacement: path.join(
          root,
          "packages/sdk-dashboard/node_modules/drizzle-cube/dist/adapters/mcp-tools.js",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    // Real pg round trips per assertion, plus a schema build in beforeAll.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/__tests__/integration/unknown-cost-aggregation.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here. The suite skips without a live database (a DB tier must
      // not red an ordinary unit run), and a suite whose only failure mode is
      // "skipped" reports success by doing nothing. This flag says "you are in
      // the lane that exists to run it", turning a missing database from a
      // silent skip into a hard, self-describing failure.
      CINATRA_UNKNOWN_COST_REALDB: "1",
    },
  },
});
