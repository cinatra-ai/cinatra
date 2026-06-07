import { defineConfig } from "vitest/config";
import * as path from "node:path";

const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      SUPABASE_DB_URL: "postgres://unused:unused@localhost:5432/unused",
    },
  },
});
