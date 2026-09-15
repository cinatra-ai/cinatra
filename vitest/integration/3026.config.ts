import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3026 (epic #3023, lifecycle-c W2) — DEDICATED config for THE EDITOR'S
// SAVE against a real database.
//
// WHY A SEPARATE CONFIG. The unit tier proves what the save road decides over
// substituted ports. What it cannot prove is that Postgres agrees: that the
// append's expected base is a real compare-and-set — §8.3's "a save that names a
// base another save has already built on fails on THAT INDEX" — against the
// production DDL, unique index, `representation_form_chk` and append-only
// trigger included, and that the edit's audit row commits with the revision it
// describes or not at all. A stubbed store would agree with whatever the code
// said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-c-w2
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3027 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w2_editor_3026";

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
    include: ["src/lib/artifacts/__tests__/lifecycle-c-w2-editor-save.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_LIFECYCLE_C_W2_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3026-placeholder-not-a-credential",
    },
  },
});
