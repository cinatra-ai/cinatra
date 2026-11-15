import { defineConfig } from "vitest/config";
import * as path from "node:path";
import rootConfig from "../../vitest.config";

// cinatra#4379 — DEDICATED config for THE TYPED PROMOTION THROUGH THE REAL
// CANONICAL WRITER against a real database.
//
// WHY A SEPARATE CONFIG. The #3028 tier (`3028.config.ts`) proves the typed
// promotion road's data effects with a substituted retype, because its config
// aliases only `server-only` and the canonical writer's module graph is the
// application boot graph (the org-write authority and the session module, the
// connector service registration, the MCP request context). This tier runs
// that writer itself, so the one fact the promotion's convergence rests on is
// proved against Postgres: the retype's change event carries the promotion's
// key and the base version it was anchored on, and the store's proof read
// accepts only that event.
//
// The root config deliberately EXCLUDES `**/*.integration.test.ts`; this one
// includes exactly one file. Point it at a scratch Postgres:
//   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:typed-promotion-real-writer
// The suite self-skips without one, so any OTHER config that picks it up keeps
// the ordinary skip; under this config a missing database is a hard failure.
//
// IN CI it runs as the second half of `pnpm test:lifecycle-c-w4` (an `&&`
// chain), so the #3028 tier's own real-database step runs both tiers against
// the same job's Postgres, and direction 4 of
// `scripts/audit/ci-pinned-tests-exist.mjs` credits this config through that
// aggregate script.
const root = path.resolve(__dirname, "..", "..");

// THE ROOT CONFIG'S OWN ALIAS LIST, reused rather than re-typed, as the #3030
// tier does: the root list is the maintained provisioning of the boot graph the
// writer loads (the auth, skills, llm and registry stubs and the workspace
// leaves). A copied subset would drift from it and fail on whichever leaf the
// graph reaches next.
const rootResolve = (rootConfig as { resolve?: { alias?: unknown } }).resolve ?? {};
const rootAlias = (rootResolve.alias ?? []) as Array<{
  find: string | RegExp;
  replacement: string;
}>;
const rootEnv =
  (rootConfig as { test?: { env?: Record<string, string> } }).test?.env ?? {};

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
    // One file. Its schema and organization are this run's own (a random name per
    // run, set by the suite itself before any app module loads), so two runs of
    // this tier against one database never touch each other's state.
    fileParallelism: false,
    include: [
      "src/lib/artifacts/__tests__/typed-promotion-canonical-writer-4379.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    env: {
      ...rootEnv,
      // The suite SELF-SKIPS without a live database, and a suite whose only
      // failure mode is "skipped" reports success by doing nothing. This flag
      // says "you are in the lane that exists to run these".
      CINATRA_TYPED_PROMOTION_WRITER_REALDB: "1",
      // Nothing in this tier signs or verifies anything. A fixed placeholder is
      // what belongs here; it is not a credential and must never be treated as one.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x4379-placeholder-not-a-credential",
    },
  },
});
