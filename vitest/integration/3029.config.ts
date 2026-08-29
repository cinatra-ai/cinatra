import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3029 (epic #3023 W5) — DEDICATED config for THE DEFAULT ROAD's run
// against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit tier proves
// the two ladders — the detection ladder's rungs and the per-output ladder's
// rungs — as tables, against pure inputs. What it cannot prove is that Postgres
// agrees about what those verdicts PRODUCE: that an undeclared output really
// becomes an artifact of the right base, that the rung and its verdict really
// land on the materialization ledger's row, that identical bytes in one run
// really collapse to one artifact with two ledger rows, and that response text
// really writes nothing. A stubbed store would agree with whatever the code said
// about all four.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:default-road
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #2928, #2932 and #2935 tiers' shape.
//
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below climbs back out of it.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_default_road_3029";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      {
        // The SAME anchored alias the root config carries, for the same
        // pre-existing reason: the bare `@cinatra-ai/skills` barrel pulls
        // `@cinatra-ai/llm` and the app-layer database module, which are not
        // resolvable in a vitest sandbox, and `src/lib/mcp-instructions.ts`
        // calls `readLocalPackageSkillContent` in a TOP-LEVEL IIFE that crashes
        // module load when the named export resolves undefined. Anchored to the
        // bare specifier so real subpaths fall through to tsconfigPaths.
        find: /^@cinatra-ai\/skills$/,
        replacement: path.join(root, "tests/__stubs__/cinatra-skills.ts"),
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
      "src/lib/artifacts/__tests__/default-road-pickup.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as
      // one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3029-placeholder-not-a-credential",
    },
  },
});
