import { defineConfig } from "vitest/config";

// Per-package vitest for @cinatra-ai/sdk-dashboard. The package currently has
// the ESLint boundary regression test; the test invokes the repo's ESLint flat
// config via the CLI against fixture files and asserts each rule fires.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Boundary tests shell out to `pnpm exec eslint`; give them headroom.
    testTimeout: 60_000,
  },
});
