import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3028 (epic #3023, lifecycle-c W4) — DEDICATED config for the
// OBJECT-BACKED CONTRACT (enabler 0.13) and the TYPED PROMOTION ROAD (enabler
// 0.14) against a real database.
//
// WHY A SEPARATE CONFIG. The unit tier proves what each road DECIDES against
// substituted ports. What it cannot prove is that Postgres agrees: that the
// mint's produced event commits inside the capture's own transaction and
// survives the outbox's `emitter` CHECK (the constraint core__0099 widens), that
// the guard keeps a reuse from emitting, that the promotion's compare-and-set
// actually retypes, and that the appended revision points at the SAME resource
// row while the append-only trigger leaves the earlier revisions untouched. A
// stubbed store would agree with whatever the code said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-c-w4
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3027 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w4_object_backed_3028";

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
      "src/lib/artifacts/__tests__/lifecycle-c-w4-object-backed-and-promotion.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these".
      CINATRA_LIFECYCLE_C_W4_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3028-placeholder-not-a-credential",
    },
  },
});
