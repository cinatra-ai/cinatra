import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#2691 — DEDICATED config for the WEEK-WINDOW TIMEZONE tier.
//
// WHY A SEPARATE CONFIG. This suite MUTATES `process.env.SUPABASE_DB_URL` to
// carry a non-UTC `-c timezone=…` startup option, which the store's pool
// (packages/metric-cost-api/src/db.ts) picks up on its first query and then
// MEMOIZES for the rest of the process. Any other suite that touched that
// pool first (against the plain URL) would poison this one; running this file
// alone, in its own vitest process, is what guarantees the FIRST access is
// this suite's own. It mirrors the cinatra#2578 / #2669 tiers' reasoning for
// the same isolation, one env mutation removed.
//
// It does NOT inherit the root config — the root's stub set is not what this
// tier needs, and stating the alias list here keeps the one alias it does
// need (server-only, pulled in transitively by store.ts) explicit.
const root = __dirname;

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "packages/metric-cost-api/tests/__stubs__/server-only.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // Real pg round trips per assertion, plus a schema build in beforeAll.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/__tests__/integration/week-window-timezone.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here — see the cinatra#2669 config for why a suite whose
      // only failure mode is "skipped" is not a gate.
      CINATRA_WEEK_WINDOW_REALDB: "1",
    },
  },
});
