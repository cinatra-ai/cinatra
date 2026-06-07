import { defineConfig } from "vitest/config";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Integration test config
//
// Runs only the *.integration.test.ts files. These require real infrastructure
// (PostgreSQL + Redis + a running background worker) and are skipped by the
// default unit-test suite. Invoke via `pnpm --filter @cinatra-ai/a2a test:integration`.
// ---------------------------------------------------------------------------

const serverOnlyStub = path.join(
  __dirname,
  "src/__tests__/__stubs__/server-only.ts",
);

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.integration.test.ts"],
    // Integration tests poll a BullMQ worker over Redis and talk to Postgres;
    // keep test timeouts generous (per-test timeouts are also set in code).
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
