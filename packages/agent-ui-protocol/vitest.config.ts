import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(
  __dirname,
  "src/__tests__/__stubs__/server-only.ts",
);

const a2aStub = path.join(
  __dirname,
  "src/__tests__/__stubs__/a2a.ts",
);

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" is a Next.js-only package — stub it in the test environment
      "server-only": serverOnlyStub,
      // @cinatra-ai/a2a pulls in Redis/DB deps; stub it so unit tests stay isolated
      "@cinatra-ai/a2a": a2aStub,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
