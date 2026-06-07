/**
 * Path-gated Playwright config for the Release Workflows browser e2e.
 *
 * Hermetic — exercises the workflow management surface end-to-end in a real
 * browser against a real Postgres, with NO LLM/connector keys (the seeded
 * workflow uses checkpoint/manual tasks only). Complements the package's 68
 * engine integration tests, which cover the durable engine hermetically.
 *
 * Runs against a Next.js dev server on E2E_PORT (default 3100; locally point it
 * at an already-warm worktree server, e.g. `E2E_PORT=3001`). The seed writes
 * directly via pg, so SUPABASE_DB_URL + SUPABASE_SCHEMA must match the target
 * server's DB/schema:
 *
 *   E2E_PORT=3001 SUPABASE_SCHEMA=cinatra_worktree_release_wf \
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres \
 *   pnpm test:e2e:workflows
 *
 * Wired into the build-image.yml PR gate as the `workflows-e2e` job (mirrors
 * the RBAC e2e pattern): a prod-build standalone server on port 3000, the
 * committed Better-Auth `public.*` SQL seed, and CINATRA_E2E_SETUP_BYPASS=true
 * for the fresh-instance /setup redirect. The engine integration suite remains
 * the always-on package gate; this is the representative end-to-end arm.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, repoPath, REPO_ROOT, suitePath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("workflows"),
  outputDir: repoPath("test-results"),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,
  // Hard cap on the full suite in CI. Mirrors the same RBAC defensive cap: per-test
  // 60s × retries:2 × hydration waits can naturally consume the workflow's
  // ~25-min shell timeout on a slow runner; the global cap fails-fast with
  // artifacts/logs preserved instead of looking like an unbounded hang.
  // 10 min is generous over the typical ~9 min runtime.
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  // When the CI workflow has already booted a standalone production server
  // (E2E_REUSE_SERVER=1), Playwright must NOT silently fall back to `pnpm dev`
  // if that external server dies mid-suite — masks the real failure AND
  // cold-boots Turbopack. Disable webServer in that path; locally manage as
  // before. Same defensive change as the RBAC e2e config.
  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        command: `PORT=${PORT} pnpm dev`,
        cwd: REPO_ROOT,
        url: BASE_URL,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...desktopChrome,
        storageState: suitePath("workflows", ".auth/state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
