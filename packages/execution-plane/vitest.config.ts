import { defineConfig } from "vitest/config";
import * as path from "node:path";

// Package-scoped vitest for @cinatra-ai/execution-plane (unit tests only — the
// real-Docker E2E battery lives behind vitest.e2e.config.ts). The single alias
// mirrors the root tsconfig path for the narrow execution-plane subgraph of
// @cinatra-ai/llm (session seal/open + types), which is runtime-light and pulls
// no server-only/app modules.
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
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/__tests__/e2e/**"],
  },
});
