import { defineConfig } from "vitest/config";
import * as path from "node:path";

// Live-proof config: stub `server-only`, but resolve `@cinatra-ai/a2a` to the
// REAL event-log shim so the proof streams over genuine Redis Streams.
export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(
        __dirname,
        "../src/__tests__/__stubs__/server-only.ts",
      ),
      "@cinatra-ai/a2a": path.join(__dirname, "a2a-event-log-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["live-proof/**/*.proof.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
