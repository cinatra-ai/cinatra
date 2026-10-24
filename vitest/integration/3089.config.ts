import { defineConfig } from "vitest/config";
import * as path from "node:path";
import rootConfig from "../../vitest.config";

// cinatra#3089 (lifecycle-d W1), acceptance item 5 — DEDICATED config for THE
// EMAIL FAN-OUT CUTOVER BEING FORWARD-ONLY, against a real database.
//
// WHY A SEPARATE CONFIG. The unit tier proves what the fan-out DECIDES against
// substituted ports. What it cannot prove is what the fan-out leaves alone: that
// the raw body rows and associations a send wrote before the cutover are
// byte-identical after the ledgered fan-out has run over the same send twice. A
// stubbed store cannot rewrite a row, so it cannot show that none was rewritten.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL=THE-SCRATCH-DSN pnpm test:email-fanout-history
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #3030 and #3032 tier shape and reasoning.
const root = path.resolve(__dirname, "..", "..");

// THE ROOT CONFIG OWN ALIAS LIST, reused rather than re-typed — the same
// reasoning the #3030 tier records: this tier drives the REAL write path, whose
// module graph reaches the workspace leaves the root config aliases by hand, and
// a copied subset would drift from the list that is actually maintained.
const rootAlias = ((rootConfig as { resolve?: { alias?: unknown } }).resolve?.alias ??
  []) as Array<{ find: string | RegExp; replacement: string }>;

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_test_email_fanout_history_3089";

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
      "src/lib/artifacts/__tests__/run-artifact-materializer-email-fanout-history-3089.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these".
      CINATRA_EMAIL_FANOUT_HISTORY_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3089-placeholder-not-a-credential",
    },
  },
});
