import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2911 — DEDICATED config for the agent_runs.created_at IMMUTABILITY tier.
//
// WHY A SEPARATE CONFIG. The root config deliberately EXCLUDES
// `**/*.integration.test.ts` (those suites need a real Postgres and must never
// "pass" as skipped inside the unit tier). This suite needs the opposite: a real
// database, because the thing under test is what a REPLAY of the bootstrap DDL
// does to rows that already exist. A stubbed runner cannot rewrite a row, so a
// stubbed run would prove nothing. Mirrors the #2578 / #2669 / #2691 / #2696 /
// #2882 tiers' isolation reasoning.
//
// This config REFUSES to run without a real `SUPABASE_DB_URL` (see the
// CINATRA_CREATED_AT_IMMUTABLE_REALDB note below) — point it at a scratch
// Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:created-at-immutable
// The suite itself still self-skips without one, so any OTHER config that picks
// it up keeps the ordinary skip.
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below has to climb back out of it — the paths
// themselves are unchanged, and still name the same files they always did.
const root = path.resolve(__dirname, "..", "..");

// The throwaway schema this tier builds, drops and rebuilds. It is ALSO what
// `packages/agents/src/schema.ts` binds its tables to (it reads SUPABASE_SCHEMA
// at module import), so the terminal-transition half of the suite writes through
// the real store primitive into the same throwaway schema the replay runs
// against. A fixed name, not a random one: the schema module reads the variable
// at import time, before any test body can compute one.
const TEST_SCHEMA = "cinatra_x2911";

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
    // beforeAll builds a whole throwaway schema from the bootstrap list, and
    // every replay runs that list again.
    testTimeout: 240_000,
    hookTimeout: 300_000,
    // Serial: the suite mutates ONE shared schema (it drops the column to prove
    // the legacy backfill still fires), so nothing may run beside it.
    fileParallelism: false,
    include: [
      "src/lib/__tests__/agent-run-created-at-immutable.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here. The suite SELF-SKIPS without a live database, and a suite
      // whose only failure mode is "skipped" reports success by doing nothing.
      // This flag says "you are in the lane that exists to run these", turning a
      // missing SUPABASE_DB_URL from a quiet skip into a hard, self-describing
      // throw. Escape hatch, for a deliberate no-DB smoke of the config itself:
      //   X2911_ALLOW_SKIP=1 pnpm test:created-at-immutable
      CINATRA_CREATED_AT_IMMUTABLE_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // The terminal-write half imports the real store primitive, whose module
      // graph reaches the app's auth config and refuses to load unbound. Nothing
      // in this tier signs or verifies anything — no session is created, no
      // token is minted — so a fixed placeholder is what belongs here. It is not
      // a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2911-placeholder-not-a-credential",
    },
  },
});
