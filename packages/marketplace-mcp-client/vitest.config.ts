import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  resolve: {
    alias: [
      // http-client.ts imports `server-only`; map it to the repo stub so the
      // module is importable under Node/vitest (matches the root vitest config).
      {
        find: "server-only",
        replacement: path.join(__dirname, "../../tests/__stubs__/server-only.ts"),
      },
    ],
  },
});
