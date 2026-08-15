import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2696 — DEDICATED config for the INSTALL-SEMANTICS WRITE-PATH tier.
//
// WHY A SEPARATE CONFIG. The root config deliberately EXCLUDES
// `**/*.integration.test.ts`: those suites need a real Postgres, so they must
// never run (and never silently "pass" as skipped) inside the unit tier. This
// tier drives the REAL canonical store + lifecycle primitive against a real DB
// to prove the workspace-anchored row the write path resolves actually lands,
// reads back by identity, coexists with an organization-anchored row without
// touching it, and rolls back to nothing. Mirrors the #2578 / #2669 / #2691
// tiers' isolation reasoning.
//
// It does NOT inherit the root config — the root's stub set would replace
// `@/lib/database` with the inert unit stub, which is exactly the wiring this
// tier must exercise for real. The one alias it does need (server-only, pulled
// in transitively by canonical-store / lifecycle-primitive) is stated here.
//
// The suite SELF-SKIPS without a real `SUPABASE_DB_URL`, so it is safe to run
// anywhere; point it at a scratch Postgres:
//   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
//     pnpm test:install-semantics
const root = __dirname;

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // Real pg round trips per assertion, plus a schema build in beforeAll.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // The INSTALL-SEMANTICS tier — extended per slice, never forked: S2's write
    // path and S3's connector substrate share the same isolation reasoning, the
    // same real-Postgres requirement, and the same `pnpm test:install-semantics`
    // entry point.
    include: [
      "src/lib/__tests__/install-semantics-write-path.integration.test.ts",
      "src/lib/__tests__/install-semantics-connector-substrate.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
  },
});
