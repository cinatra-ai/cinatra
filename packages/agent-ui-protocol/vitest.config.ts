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
    // The wholesale package suite runs on the same constrained self-hosted
    // runner as the root suite and hits the same starvation under load —
    // imports and hooks alone can cross vitest's 5s/10s defaults. Give
    // tests and hooks the same 30s headroom as the root suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // The integration tier needs a real Redis; the wholesale package run has
    // none. It runs separately via `pnpm test:agent-ui-durable-resume`
    // (vitest/integration/3067.config.ts), so exclude it here explicitly — a
    // file-name suffix alone does not change vitest discovery.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
