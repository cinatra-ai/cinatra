import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2933 (epic #2926 W5b) — DEDICATED config for the PER-RUN WINDOW
// CONVERSATION against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The unit tier proves
// the store's IDIOMS against an in-memory stand-in that behaves the way
// Postgres does. What it cannot prove is that Postgres agrees: that the shipped
// bootstrap really creates `agent_run_messages` with the (run_id, sequence)
// UNIQUE index the append relies on to detect a race, that a SECOND connection
// reading the run really sees what the first wrote — which is what "present
// after a reload" means — and that the replay reader's exclusion really holds
// in SQL, so the run's own thread keeps returning exactly what it returned
// before this slice put a second use on the table.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:run-window
// The suite self-skips without one, so any OTHER config that picks it up keeps
// reporting green rather than failing for a reason that is not the code's.

const TEST_SCHEMA = "cinatra_x2933";

export default defineConfig({
  resolve: {
    // `__dirname` is `vitest/integration/`; the app source is two levels up. The
    // directory it names is unchanged — still the repository's own `src/`.
    alias: { "@": path.resolve(__dirname, "..", "..", "src") },
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/lib/lifecycle/__tests__/run-window-conversation.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_RUN_WINDOW_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
    },
  },
});
