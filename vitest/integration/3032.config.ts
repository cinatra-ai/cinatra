import { defineConfig } from "vitest/config";
import * as path from "node:path";
import rootConfig from "../../vitest.config";

// cinatra#3032 (epic #3023, lifecycle-c W8) — DEDICATED config for THE IMAGE
// TOOL (enabler 0.28) against a real database and a real disk.
//
// WHY A SEPARATE CONFIG. The unit tier proves what the tool DECIDES against
// substituted ports. What it cannot prove is that Postgres and a filesystem
// agree: that the picture is filed as a real objects row of the extension own
// declared type carrying the data the caller named, that the bytes the provider
// produced are the bytes on disk, that the finalized ledger row of that write
// carries the prompt, the provider and the model, and that a regeneration
// appends revision 2 to the SAME artifact — refused by the unique index on
// (organisation, artifact, revision) when it names a base another write already
// built on. A stubbed store would agree with whatever the code said.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL=THE-SCRATCH-DSN pnpm test:lifecycle-c-w8
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3030 tier shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

// THE ROOT CONFIG OWN ALIAS LIST, reused rather than re-typed — the same
// reasoning the #3030 tier records: this tier drives the REAL write path, whose
// module graph reaches the workspace leaves the root config aliases by hand, and
// a copied subset would drift from the list that is actually maintained.
const rootAlias = ((rootConfig as { resolve?: { alias?: unknown } }).resolve?.alias ??
  []) as Array<{ find: string | RegExp; replacement: string }>;

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_w8_image_tool_3032";

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
      "src/lib/artifacts/__tests__/lifecycle-c-w8-image-tool.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these".
      CINATRA_LIFECYCLE_C_W8_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3032-placeholder-not-a-credential",
    },
  },
});
