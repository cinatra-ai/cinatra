import { defineConfig } from "vitest/config";

import chatConfig from "./packages/chat/vitest.config";

// cinatra#2823 (epic #2784 S9j) — DEDICATED config for the DURABLE
// STREAM → STORE → RELOAD contract tier.
//
// WHY A SEPARATE CONFIG, and why it is not one of the three that already exist.
//
//   * The ROOT config excludes `**/*.integration.test.ts` and runs `environment:
//     "node"`. This tier needs BOTH a live Postgres and a DOM: it drives the real
//     sink, persists through the real thread store, reloads from Postgres alone
//     and then MOUNTS the real `/chat` conversation column on what came back. A
//     suite that could only do the first half would be measuring the store, not
//     the screen.
//   * The CHAT package config has the DOM and every alias the column's graph
//     needs, but its suite runs in `package-unit-suites`, a job with no database.
//     A DB-backed file there would have to self-skip, and a tier that skips is a
//     tier that proves nothing.
//
// So this config is the intersection: the chat package's alias set (imported,
// never re-typed — see below) plus jsdom plus the one DB-backed file.
//
// THE ALIASES ARE IMPORTED, NOT MIRRORED. `packages/chat/vitest.config.ts`
// resolves ~20 workspace subpaths, pins React to the single workspace copy so
// `@testing-library/react` does not see two, and maps the app's `@/` prefix. All
// of its paths are already absolute (it builds them from its own `__dirname`),
// so they are correct from this root. Re-typing that list here would be a second
// copy that drifts the first time the column reaches a new leaf — and the drift
// would surface as an unresolvable import in THIS tier only, i.e. as a red DB job
// that has nothing to do with persistence.
//
// SELF-SKIP IS REFUSED. The tier hard-throws without `CINATRA_TEST_DB_URL`
// (mirroring `packages/agents/vitest.integration.config.ts`), because the whole
// point of #2823's acceptance is that this runs in a REQUIRED job with
// PostgreSQL. A tier that silently skipped there would report the required job
// green while proving nothing — the exact failure shape the issue is about.
//
// Run it:
//   CINATRA_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
//     pnpm test:durable-reload

const testDbUrl = process.env.CINATRA_TEST_DB_URL;
if (!testDbUrl) {
  throw new Error(
    "vitest.integration-2823.config.ts: CINATRA_TEST_DB_URL is required — this tier drives a REAL Postgres " +
      "through the real assistant thread store and must never report green without one. " +
      "Set it to a scratch database, e.g. postgresql://postgres:postgres@127.0.0.1:5432/postgres.",
  );
}
// The store reads SUPABASE_DB_URL; the tier is invoked with CINATRA_TEST_DB_URL
// (the name the DB jobs already set). Forward it in Node-land rather than in the
// package.json script, so a connection string carrying `?`/`&` survives every
// shell — the same reasoning packages/agents/vitest.integration.config.ts writes
// down for its own forwarding.
process.env.SUPABASE_DB_URL = testDbUrl;

export default defineConfig({
  resolve: {
    // Vite 8 native tsconfig `paths` reading, exactly as the root config uses it:
    // the column's graph reaches workspace subpaths the chat config does not name
    // (`@cinatra-ai/chat/thread-slug`, reached from the STORE side of this tier).
    // The explicit aliases below still win — vite runs `alias` first.
    tsconfigPaths: true,
    alias: chatConfig.resolve!.alias,
  },
  test: {
    // The reload is measured on the MOUNTED column, so the DOM is not optional.
    environment: "jsdom",
    include: [
      "src/lib/assistant-runtime/__tests__/durable-lifecycle-reload-contract.integration.test.ts",
    ],
    // Real DDL bootstrap in the first store call, then four carriages each
    // making several real round trips through the sync query worker.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    env: {
      // Set on the worker, not only on this process (the root config's own
      // comment records why a config-time assignment alone does not reach the
      // test workers).
      SUPABASE_DB_URL: testDbUrl,
      SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA ?? "cinatra",
      // The schedule carriage now persists the REAL run-scoped card reference
      // (cinatra#3044), and the ref codec derives its key from the app secret —
      // no secret, no ref, and a carriage that would silently prove nothing.
      // Nothing in this tier signs or verifies anything: no session is created
      // and no token is minted, so a fixed placeholder is what belongs here. It
      // is not a credential and must never be treated as one. Same reasoning,
      // same shape as the lifecycle-moment tier's own placeholder.
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "x2823-placeholder-not-a-credential",
    },
  },
});
