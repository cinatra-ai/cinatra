import { defineConfig } from "vitest/config";
import * as path from "node:path";

// DEDICATED config for the local-caller gate against a REAL RUNNING DEV SERVER.
//
// WHY A SEPARATE CONFIG. The root config excludes `**/*.integration.test.ts`,
// and rightly: this one boots the application's own dev server on a free port
// and drives it over HTTP, which needs the instance's `.env.local` and its
// database. What is under test cannot be answered any other way — the claim is
// about what the FRAMEWORK does to a request on its way into a route handler
// (it synthesises the `x-forwarded-*` headers), and a stubbed request would
// simply agree with whatever the code said about it. That claim had been
// inherited from a comment for two surfaces; this tier measures it.
//
// Run it against a lane database:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:loopback-peer
//
// The suite self-skips without the flag below, so any other config that picks
// the file up keeps the ordinary skip.
const root = path.resolve(__dirname, "..", "..");

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
    // A cold `next dev` compile on a constrained runner is minutes, not seconds.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Serial: the suite owns one dev server on one port.
    fileParallelism: false,
    include: [
      "src/lib/__tests__/local-caller-gate-dev-server.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // Set ONLY here. Turns "no dev server, quietly skipped" into a run that
      // actually boots one.
      CINATRA_LOOPBACK_DEV_SERVER_TEST: "1",
    },
  },
});
