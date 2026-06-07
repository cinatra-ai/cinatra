import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
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
