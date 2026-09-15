import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The wholesale package suite runs on the same constrained self-hosted
    // runner as the root suite and hits the same starvation under load —
    // imports and hooks alone can cross vitest's 5s/10s defaults. Give
    // tests and hooks the same 30s headroom as the root suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
  },
});
