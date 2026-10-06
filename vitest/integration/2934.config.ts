import { defineConfig } from "vitest/config";
import path from "node:path";

// The DB tier for the FILL ROAD (cinatra#2934, lifecycle-b W5c).
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes the files of this slice. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:screen-fill
// The suite self-skips without one, so any OTHER config that picks it up keeps
// reporting green rather than failing for a reason that is not the code's.

const TEST_SCHEMA = "cinatra_x2934";

export default defineConfig({
  resolve: {
    // `__dirname` is `vitest/integration/`; the app source is two levels up.
    // The directory it names is unchanged — still the repository's own `src/`.
    //
    // `server-only` is stubbed exactly as the root config stubs it: the modules
    // this tier drives are server modules, and the marker package throws on
    // import outside a server component. The stub is the repository's own —
    // this config points at it rather than declaring a second one.
    alias: {
      "@": path.resolve(__dirname, "..", "..", "src"),
      "server-only": path.resolve(
        __dirname, "..", "..", "tests", "__stubs__", "server-only.ts",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/lib/lifecycle/__tests__/screen-fill.integration.test.ts",
      // The armed-schedule change road: what one turn places is what the next
      // turn's plain "save that" saves (cinatra#2934, after the graded
      // re-shoot). Same tier, same scratch schema, same self-skip.
      "src/lib/lifecycle/__tests__/armed-schedule-save-road.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_SCREEN_FILL_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
    },
  },
});
