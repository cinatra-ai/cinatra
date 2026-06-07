/**
 * Path-gated Playwright config for the notifications flyout UAT.
 *
 * Mirrors the shape of the dashboards suite config — port 3100
 * by default, single-worker, reuse-existing-dev-server locally. Run
 * against a feature-branch clone where the worktree's `.env.local` boots
 * Next.js on port 3100 and
 * targets its dedicated clone DB. The test seeds notifications directly
 * via pg, so no special CI-side mounting is needed beyond the standard
 * Postgres + Redis service containers.
 *
 * Run locally:
 *   pnpm dev                              # in another shell, on port 3100
 *   pnpm test:e2e:notifications           # this config
 *
 * Or:
 *   pnpm exec playwright test \
 *     -c tests/e2e/config/notifications.config.ts
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("notifications"),
  outputDir: repoPath("test-results"),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  webServer: {
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
        storageState: suitePath("notifications", ".auth/state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
