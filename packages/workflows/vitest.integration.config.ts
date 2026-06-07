import { defineConfig } from "vitest/config";
import * as path from "node:path";
import * as fs from "node:fs";

const root = path.resolve(__dirname, "../..");

// Integration tests require an isolated Postgres schema (run `cinatra setup
// branch` first; in CI provide CINATRA_TEST_DB_URL). Loads .env.local so the
// worktree's `cinatra_<slug>` schema is used.
function loadEnvLocal() {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": path.join(__dirname, "src/__tests__/__mocks__/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    pool: "forks",
    // Integration test files share one Postgres schema and each applies the full
    // DDL in beforeAll — run them SERIALLY so concurrent DDL doesn't race
    // ("tuple concurrently updated" on the system catalogs).
    fileParallelism: false,
    // Integration tests connect to a real DB; allow more time for DDL/boot.
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      SUPABASE_DB_URL:
        process.env.CINATRA_TEST_DB_URL ??
        process.env.SUPABASE_DB_URL ??
        "postgres://unused:unused@localhost:5432/unused",
      SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA ?? "cinatra",
    },
  },
});
