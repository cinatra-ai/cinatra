import { defineConfig } from "vitest/config";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [{ find: "server-only", replacement: path.join(ROOT, "tests/__stubs__/server-only.ts") }],
  },
  test: {
    root: ROOT,
    include: ["evidence/2047-observability/walk.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks",
  },
});
