import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3091 (epic #3087, lifecycle-d W3) — DEDICATED config for the
// KIND-TYPED ROW DISPLAY question against a real database.
//
// WHY A SEPARATE CONFIG. The registry tier already proves what the resolver
// decides when it is handed a type. What it cannot prove is that a row of that
// kind can EXIST: that the write boundary accepts the type, that Postgres keeps
// it, that the media type persisted beside it is the one the pack accepts, and
// that the type read BACK out is still the kind's own. That is the whole
// question this leg was asked, and a stand-in store would have agreed with
// whatever the test said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:w3-kind-typed-row
// The suite self-skips without one. Mirrors the #3028 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w3_kind_typed_row";

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
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Serial: the suite owns ONE shared schema.
    fileParallelism: false,
    include: [
      "src/app/artifacts/[id]/__tests__/w3-kind-typed-row-display.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3091-placeholder-not-a-credential",
    },
  },
});
