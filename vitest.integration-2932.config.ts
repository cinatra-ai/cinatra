import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2932 (epic #2926 W5a) — DEDICATED config for the LENT-ACTION GRANT's
// SINGLE-USE LEDGER against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit tier proves
// the ledger's IDIOMS against an in-memory stand-in that behaves the way
// Postgres does. What it cannot prove is that Postgres agrees: that the
// bootstrap really creates the table and both of its unique constraints, that
// `INSERT ... ON CONFLICT DO NOTHING RETURNING` really returns no row when the
// (user_id, message_id) index rejects a second mint, that
// `DELETE ... RETURNING` really serializes two concurrent spends so exactly one
// wins, and that `expires_at > now()` is evaluated at the DATABASE's clock. A
// stubbed database would agree with whatever the code said about all four.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lent-action-grant
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #2928 tier's shape and its reasoning.
const root = __dirname;

/** The throwaway schema this tier builds and drops. Fixed, not computed: the
 *  store reads SUPABASE_SCHEMA per call, but a fixed name keeps the drop
 *  unambiguous. */
const TEST_SCHEMA = "cinatra_x2932";

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
      "src/lib/lifecycle/__tests__/lent-action-grant-ledger.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_LENT_ACTION_GRANT_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything — the ledger holds no
      // grant string and mints nothing. A fixed placeholder is what belongs
      // here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2932-placeholder-not-a-credential",
    },
  },
});
