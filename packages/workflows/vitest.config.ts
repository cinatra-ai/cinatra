import { defineConfig } from "vitest/config";
import * as path from "node:path";
import * as fs from "node:fs";

const root = path.resolve(__dirname, "../..");

// Auto-load .env.local from the repo/worktree root so integration tests see the
// real SUPABASE_DB_URL / SUPABASE_SCHEMA (the isolated `cinatra_<slug>` schema
// provisioned by `cinatra setup branch`). Existing process.env wins; no-ops in
// CI when .env.local is absent.
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
    // Vite 8 native: read tsconfig.json `paths` so workspace imports resolve.
    tsconfigPaths: true,
    alias: {
      "server-only": path.join(__dirname, "src/__tests__/__mocks__/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    // Integration tests (isolated Postgres schema) run via `pnpm test:integration`.
    exclude: ["**/*.integration.test.ts"],
    // Forks pool for true process isolation (prevents cross-file mock leaks —
    // same rationale as packages/agents).
    pool: "forks",
    env: {
      SUPABASE_DB_URL:
        process.env.SUPABASE_DB_URL ?? "postgres://unused:unused@localhost:5432/unused",
    },
  },
});
