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
// The suite SELF-SKIPS without a real `SUPABASE_DB_URL`, so it is safe to run
// anywhere; point it at a scratch Postgres:
//   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
//     pnpm test:async-notification-seam
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
  },
});
