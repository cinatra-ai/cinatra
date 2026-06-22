import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.{ts,mts,mjs}"],
    environment: "node",
    testTimeout: 10_000,
  },
});
