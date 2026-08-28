import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2935 (epic #2926 W5d) — DEDICATED config for the NAMED START's run
// against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit tier proves
// the order of the start's gates and WHICH envelope it is made with, against
// substituted ports. What it cannot prove is that Postgres agrees about the row
// that envelope produces: that the run is really created with the acting person
// as its owner in their organization, and that a refused launch really leaves
// the table as it found it. A stubbed database would agree with whatever the
// code said about both.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:named-agent-start
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #2928 and #2932 tiers' shape and reasoning.
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below has to climb back out of it — the paths
// themselves are unchanged, and still name the same files they always did.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_x2935";

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
      "src/lib/lifecycle/__tests__/named-agent-start.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_NAMED_AGENT_START_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as
      // one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2935-placeholder-not-a-credential",
    },
  },
});
