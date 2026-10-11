import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2853 (the second fix leg) — DEDICATED config for THE WHOLE TYPED
// SCHEDULE ADJUST against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit and component
// tiers prove the two halves in isolation: the handler's arms against a
// substituted decide, and the mounted card's in-place re-draw against a
// substituted resolve. Neither can fail for the defect this leg closes, which
// lives in the chain BETWEEN them — the send's one ledger row, the press that
// spends it, the re-proposal that mints a replacement ref, and the answer that
// has to carry that ref back to the page as an announcement rather than as a
// second card. Only a real store can answer whether that chain holds, and a
// stubbed one would agree with whatever the code said about it.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL=<your scratch-database DSN> pnpm test:typed-schedule-adjust
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3052 tier's shape and its reasoning.
//
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below has to climb back out of it.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_x2853";

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
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Serial: the suite owns ONE shared schema.
    fileParallelism: false,
    // The bound-card road's graph reads the Better Auth tables at IMPORT time,
    // so the scratch schema and the public floor have to exist before the suite
    // is loaded at all — which is what a global setup is and a hook is not.
    globalSetup: ["src/lib/lifecycle/__tests__/typed-schedule-adjust-redraw.setup.ts"],
    include: [
      "src/lib/lifecycle/__tests__/typed-schedule-adjust-redraw.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_TYPED_SCHEDULE_ADJUST_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // The grant this tier mints and verifies is minted and verified inside the
      // same process, against a throwaway schema. Nothing here is a credential
      // and nothing here may ever be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2853-placeholder-not-a-credential",
    },
  },
});
