import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mts,mjs}"],
    environment: "node",
    testTimeout: 10_000,
  },
});
