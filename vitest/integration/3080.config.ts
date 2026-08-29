import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3080 (epic #3023) — DEDICATED config for THE REVIEW FLOOR's real-store
// tier: Comment · Regenerate · Continue against a real Postgres.
//
// WHY A SEPARATE CONFIG. The unit tier proves which road each floor action takes
// — that Comment no longer reaches the change road, that Regenerate is the only
// caller of it, that each refusal is stated. What it cannot prove is what the
// STORE then does: that a comment really leaves the gate pending and opens no
// successor, that a double press really re-derives one repair rather than two,
// and that whichever of Continue and Regenerate reaches the gate CAS first
// really wins. A stubbed store would agree with whatever the code said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:review-floor
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3027 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_review_floor_3080";

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
    include: ["src/app/artifacts/[id]/__tests__/review-floor.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    env: {
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3080-placeholder-not-a-credential",
    },
  },
});
