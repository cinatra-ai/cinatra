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
      {
        // The bare `@cinatra-ai/skills` barrel pulls heavy deps this tier does
        // not resolve, exactly as in the root config — stub the bare specifier
        // and let real subpaths fall through to tsconfigPaths. Reached from the
        // repair-inheritance file below through the artifact-type registrar.
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
      "src/app/artifacts/[id]/__tests__/review-floor.integration.test.ts",
      // The repair's half of the same floor: a Regenerate reaches the work with
      // NO human step, because the screen the producing run already answered is
      // not asked again. It needs the un-stubbed `@/lib/database` this config
      // gives (the root config aliases it away), and it builds and drops its
      // OWN schema from inside its `beforeAll` — the tier is serial, so the two
      // files never overlap.
      "src/lib/artifacts/__tests__/context-repair-inheritance.integration.test.ts",
      // The same decision one layer up, with nothing stubbed between the
      // route and the audit store: what `/api/context-resolve` actually
      // answers the child flow decides whether a person stands in the
      // repair's road, and leg 2 could only see that with the decision
      // mocked out.
      "src/app/api/context-resolve/__tests__/repair-real-road.integration.test.ts",
      // AND THE PIN THE REGENERATE LEAVES BEHIND (cinatra#3080, fix leg 8): the
      // successor is a new REVISION of the artifact the review pinned, never a
      // second artifact. Read out of a real store, both pins, the way a proof
      // round reads them off the two gate rows.
      "src/lib/artifacts/__tests__/artifact-revision-append.integration.test.ts",
    ],
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
