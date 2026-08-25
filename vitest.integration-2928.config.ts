import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2928 (epic #2926 W2a) — DEDICATED config for the LIFECYCLE MOMENT
// TRIPLE against a real database.
//
// WHY A SEPARATE CONFIG. The root config deliberately EXCLUDES
// `**/*.integration.test.ts`: those suites need a real Postgres and must never
// "pass" as skipped inside the unit tier. This one needs the opposite. What is
// under test is what the BOOTSTRAP really produces — three new columns and a
// partial index on a table that already exists — and whether the guarded writer
// really writes and clears them. A stubbed database cannot answer either
// question: it would agree with whatever the code said. Mirrors the #2911 tier's
// isolation reasoning, and reuses its shape.
//
// This config REFUSES to run without a real `SUPABASE_DB_URL` — point it at a
// scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-moment
// The suite itself still self-skips without one, so any OTHER config that picks
// it up keeps the ordinary skip.
const root = __dirname;

// The throwaway schema this tier builds, drops and rebuilds. It is ALSO what
// `packages/agents/src/schema.ts` binds its tables to (it reads SUPABASE_SCHEMA
// at module import), so the writer half of the suite writes through the real
// store primitive into the same throwaway schema the bootstrap ran against. A
// fixed name, not a computed one: the schema module reads the variable at import
// time, before any test body could compute one.
const TEST_SCHEMA = "cinatra_x2928";

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
    // beforeAll builds a whole throwaway schema from the bootstrap list.
    testTimeout: 240_000,
    hookTimeout: 300_000,
    // Serial: the suite owns ONE shared schema.
    fileParallelism: false,
    include: [
      "src/lib/__tests__/agent-run-lifecycle-moment.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here. The suite SELF-SKIPS without a live database, and a suite
      // whose only failure mode is "skipped" reports success by doing nothing.
      // This flag says "you are in the lane that exists to run these", turning a
      // missing SUPABASE_DB_URL from a quiet skip into a hard, self-describing
      // throw. Escape hatch, for a deliberate no-DB smoke of the config itself:
      //   X2928_ALLOW_SKIP=1 pnpm test:lifecycle-moment
      CINATRA_LIFECYCLE_MOMENT_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // The writer half imports the real store primitive, whose module graph
      // reaches the app's auth config and refuses to load unbound. Nothing in
      // this tier signs or verifies anything — no session is created, no token
      // is minted — so a fixed placeholder is what belongs here. It is not a
      // credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2928-placeholder-not-a-credential",
    },
  },
});
