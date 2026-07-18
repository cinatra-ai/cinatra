import { defineConfig } from "vitest/config";
import * as path from "node:path";

// The Docker E2E battery (exec-plane S1 ACs). Requires a running docker daemon
// and builds the L0 image from docker/sandbox/Dockerfile on first run; several
// scenarios exercise REAL network egress through the gateway. Deliberately not
// part of the default `pnpm test` run — invoke with `pnpm test:e2e`. The
// battery FAILS (never skips) when docker is unavailable: a green run always
// means the real thing ran (no stub-smoke).
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@cinatra-ai/llm/execution-plane",
        replacement: path.resolve(
          __dirname,
          "../llm/src/execution-plane/index.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/__tests__/e2e/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The battery shares one docker daemon, one gateway container name and one
    // internal network — strictly serial by design.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
