import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2882 — DEDICATED config for the ASYNC NOTIFICATION-SEAM tier.
//
// WHY A SEPARATE CONFIG. The root config deliberately EXCLUDES
// `**/*.integration.test.ts` (those suites need a real Postgres and must never
// "pass" as skipped inside the unit tier), and it aliases `@/lib/database` to an
// inert stub. This tier needs the opposite of both: a real database, and the
// REAL `@/lib/postgres-sync` / `@/lib/postgres-async` runners, because the thing
// under test IS the difference between them — a delete driven over the
// synchronous `Atomics.wait` bridge versus the same delete over the async pool.
// A stubbed runner cannot freeze an event loop, so a stubbed run would prove
// nothing. Mirrors the #2578 / #2669 / #2691 / #2696 tiers' isolation reasoning.
//
// This config REFUSES to run without a real `SUPABASE_DB_URL` (see the
// CINATRA_ASYNC_NOTIFICATION_SEAM_REALDB note on `env` below) — point it at a
// scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' \
//     pnpm test:async-notification-seam
// The suites themselves still self-skip without one, so any OTHER config that
// picks them up (the root tier under CINATRA_DB_INTEGRATION_TESTS=1, say) keeps
// the ordinary skip.
const root = __dirname;

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
    // Each event-loop proof deliberately spends ~1.2s blocked on a table lock,
    // and beforeAll builds a throwaway schema.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Serial: the two event-loop proofs assert on wall-clock ordering, and the
    // sync half FREEZES its worker's main thread by design. Sharing a worker
    // with anything else would make both readings meaningless.
    fileParallelism: false,
    include: [
      "src/lib/__tests__/notification-delete-async-seam.integration.test.ts",
      "src/lib/__tests__/agent-run-wait-notifications-async-clear.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here. Both suites SELF-SKIP without a live database, and a
      // suite whose only failure mode is "skipped" reports success by doing
      // nothing — the same shape of silence #2882 is about. This flag says "you
      // are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing setup
      // throw. The root config never sets it (and excludes the integration tier
      // outright), so a machine with no Postgres still runs green there.
      // Escape hatch, for a deliberate no-DB smoke of the config itself:
      //   X2882_ALLOW_SKIP=1 pnpm test:async-notification-seam
      CINATRA_ASYNC_NOTIFICATION_SEAM_REALDB: "1",
      // The seam's ceiling (see `@/lib/postgres-async`), shrunk from its 30s
      // production default so the bound is provable inside a test run. It still
      // sits comfortably above the ~1200ms the event-loop-contrast proofs spend
      // blocked on a table lock, so those are unaffected; the ceiling proof
      // holds its lock for longer than this and asserts the rejection.
      POSTGRES_ASYNC_TIMEOUT_MS: "4000",
    },
  },
});
