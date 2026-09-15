import { defineConfig } from "vitest/config";
import * as path from "node:path";
import rootConfig from "../../vitest.config";

// cinatra#3030 (epic #3023, lifecycle-c W6) — DEDICATED config for THE RUN
// FOLDER'S PICKUP (enabler 0.22), THE FILE BINDINGS AND FILE FAN-OUT (0.27) and
// THE MID-RUN REVISION (0.30) against a real database and a real disk.
//
// WHY A SEPARATE CONFIG. The unit tier proves what each road DECIDES against
// substituted ports. What it cannot prove is that Postgres and a filesystem
// agree: that a file staged in a run folder reaches the one write path and
// leaves a `default_road` ledger row under the reserved file id, that a bound
// file lands under the extension its BINDING named rather than the agent's
// declared kind, that a file pattern writes one artifact per match over one
// content-addressed resource, and that a second append naming a base the first
// already built on is refused BY THE UNIQUE INDEX with no ledger row and no
// produced event left behind. A stubbed store would agree with whatever the
// code said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:run-folder
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3028 tier's shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

// THE ROOT CONFIG'S OWN ALIAS LIST, reused rather than re-typed. This tier
// drives the REAL write path, whose module graph reaches the workspace leaves
// the root config aliases by hand (the skills reader, the actor context, the
// object registry subpaths and the rest). Copying a subset here would leave the
// tier failing on whichever leaf the graph reaches next, and a copy would drift
// from the list that is actually maintained.
const rootAlias = ((rootConfig as { resolve?: { alias?: unknown } }).resolve?.alias ??
  []) as Array<{ find: string | RegExp; replacement: string }>;

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w6_run_folder_3030";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.join(root, "tests/__stubs__/server-only.ts"),
      },
      ...rootAlias,
    ],
  },
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Serial: the suite owns ONE shared schema.
    fileParallelism: false,
    include: [
      "src/lib/artifacts/__tests__/lifecycle-c-w6-run-folder-and-revision.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these".
      CINATRA_LIFECYCLE_C_W6_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3030-placeholder-not-a-credential",
    },
  },
});
