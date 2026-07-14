import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The CLI end-to-end suite spawns real `node bin/memory.mjs` processes.
    testTimeout: 30_000,
  },
});
