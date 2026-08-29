import { defineConfig } from "vitest/config";
import * as path from "node:path";

// cinatra#3067 — DEDICATED config for the AG-UI DURABLE-RESUME tier: the
// Redis-Streams event log of an agent run, replayed and resumed.
//
// WHY A SEPARATE CONFIG, and why this tier exists at all. The package's unit
// tier aliases `@cinatra-ai/a2a` to an in-package stub whose reader yields
// nothing, so it can say nothing about ordering, about a cursor that resumes
// exactly the un-replayed suffix, or about a mixed-channel log. This tier can:
// it publishes through the real `publishAgUiEvent` into a real Redis and reads
// the frames back through the real subscriber, so a replay defect is a
// measurement here rather than a hypothesis.
//
// The package's own config deliberately EXCLUDES `src/**/*.integration.test.ts`;
// this one includes exactly that one file. Point it at a scratch Redis:
//   REDIS_URL=redis://127.0.0.1:6379 pnpm test:agent-ui-durable-resume
// Without a reachable Redis the suite FAILS rather than skipping, which is the
// property a lane that exists to run it needs.
//
// The REPOSITORY ROOT. This config lives in `vitest/integration/`, so `__dirname`
// is that directory and every path below has to climb back out of it — the paths
// themselves are unchanged, and still name the same files they always did.
const root = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" is a Next.js-only package — stub it in the test environment.
      "server-only": path.join(
        root,
        "packages/agent-ui-protocol/src/__tests__/__stubs__/server-only.ts",
      ),
      // The REAL Redis-Streams event log only (not the a2a index, which pulls
      // DB deps): the genuine durable transport, without the package's
      // unit-test a2a stub.
      "@cinatra-ai/a2a": path.join(root, "packages/a2a/src/event-log.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/agent-ui-protocol/src/__tests__/durable-resume.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
