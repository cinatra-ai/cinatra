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
//
// NO CI RUNNER, AND THE LEDGER SAYS SO. A run of this tier needs a whole
// development stack inside one job: a real Postgres, a real Redis (with the
// queue backend unreachable the boot never reaches ready and the readiness poll
// below simply times out), the per-boot secrets the start-up path refuses to
// run without, the development runtime mode (the production path needs a baked
// seed that a plain source-tree run does not produce), the companion extension
// tree the start-up hook imports, and a ready budget of minutes for a cold
// compile.
//
// One job DOES carry that combination today - the chat-HITL held-turn
// dev-runtime e2e job, which boots the development runtime, provisions both
// sidecars and already runs eight sibling tiers as steps of its own. Giving
// this tier a step there is the closure this wants, and it is a WORKFLOW
// change; the change that adds this tier does not make one, so the wiring is a
// CI-wiring change of its own.
//
// Folding the suite into one of the tiers that job already runs is not the
// answer either: every one of those configs pins `SUPABASE_SCHEMA` to a
// throwaway schema, and the development server spawned below inherits the
// environment it is spawned with - it would boot against a schema that does not
// carry the application's tables.
//
// So the tier is recorded in scripts/audit/root-tier-runner-exceptions.json
// with its slice and that reason: the second of the two lawful states that
// ledger allows, and the honest one until the step exists.
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
