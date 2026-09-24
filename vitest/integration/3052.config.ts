import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3052 — DEDICATED config for the WIDGET SCHEDULE GRANT's measurement
// against a real database.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The producer-level
// unit tier proves the grant flag in isolation: it substitutes the request
// frame and the proposal service, so it cannot fail for a defect that lives
// anywhere between the authorisation a sign-in writes and the answer the
// handler gives. This tier is the one that can — it drives the consumed
// authorisation, the widget principal, the minted and verified delegated actor
// and the real handler against Postgres, and records a reading per stage so the
// refusing stage is a measurement rather than a hypothesis.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL=<your scratch-database DSN> pnpm test:widget-schedule-grant
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip. Mirrors the #2935 tier's shape and reasoning.
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below has to climb back out of it — the paths
// themselves are unchanged, and still name the same files they always did.
const root = path.resolve(__dirname, "..", "..");

/** The throwaway schema this tier builds and drops. */
const TEST_SCHEMA = "cinatra_x3052";

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
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Serial: the suite owns ONE shared schema.
    fileParallelism: false,
    // The widget graph reads the Better Auth tables at IMPORT time, so the
    // scratch schema and the public floor have to exist before the suite is
    // loaded at all — which is what a global setup is and a hook is not.
    globalSetup: ["src/lib/lifecycle/__tests__/widget-schedule-grant.setup.ts"],
    include: [
      "src/lib/lifecycle/__tests__/widget-schedule-grant.integration.test.ts",
      // cinatra#3051 — THE WIDGET CREDENTIAL'S RENEWAL, on the same real store.
      //
      // It joins this tier rather than founding one of its own, deliberately: a
      // tier config no workflow invokes runs NOWHERE, and adding a workflow step
      // is outside a bug-fix diff. This tier is already wired and already builds
      // exactly the floor the renewal needs — the schema, the public floor and a
      // live sign-in row — so the second widget real-store suite runs beside the
      // first instead of shipping a config that would never be called. STATED
      // CONSEQUENCE: the workflow step that runs it still carries the sibling
      // slice's name in its label.
      "src/lib/__tests__/widget-credential-renewal.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these", turning a missing
      // SUPABASE_DB_URL from a quiet skip into a hard, self-describing throw.
      CINATRA_WIDGET_SCHEDULE_GRANT_REALDB: "1",
      SUPABASE_SCHEMA: TEST_SCHEMA,
      // The audience and issuer the widget OBO token is minted and verified
      // against in this tier. A fixed local origin, so the exact-match binding
      // the verifier enforces is asserted rather than inferred.
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      // Nothing in this tier is a credential: the token this signs is minted
      // and verified inside the same process, against a throwaway schema.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x3052-placeholder-not-a-credential",
    },
  },
});
