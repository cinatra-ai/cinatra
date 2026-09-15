import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3027 (epic #3023, lifecycle-c W3) — DEDICATED config for the NON-FILE
// REVISION READER's run against a real database.
//
// WHY A SEPARATE CONFIG. The unit tier proves what the preparation core does
// with a non-file member against substituted ports. What it cannot prove is that
// Postgres agrees: that the reader's (organization, artifact, revision) tuple
// check, its form filter and its projection of the pinned configuration record
// hold against the production DDL — the form CHECK constraint, the resource-kind
// CHECK constraint and the append-only trigger included. A stubbed store would
// agree with whatever the code said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-c-w3
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #2935 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w3_nonfile_3027";

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
      "src/lib/artifacts/__tests__/lifecycle-c-w3-non-file-reader.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_LIFECYCLE_C_W3_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3027-placeholder-not-a-credential",
    },
  },
});
