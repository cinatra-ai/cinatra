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
    // The integration tier needs a real Redis; the wholesale package run has
    // none. It runs separately via `pnpm test:agent-ui-durable-resume`
    // (vitest/integration/3067.config.ts), so exclude it here explicitly — a
    // file-name suffix alone does not change vitest discovery.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
