/**
 * Path-gated Playwright config for the unified /notifications v2 conformance
 * UAT (cinatra#1561, E11 of the #1549 approvals-into-notifications epic).
 *
 * Mirrors the shape of the dashboards suite config — port 3100
 * by default, single-worker, reuse-existing-dev-server locally. Run
 * against a feature-branch clone where the worktree's `.env.local` boots
 * Next.js on port 3100 and
 * targets its dedicated clone DB. The suites seed notifications AND the local
 * agent-creation approval source directly via pg, so no special CI-side mounting
 * is needed beyond the standard Postgres + Redis service containers.
 *
 * TWO viewers, two setup projects: the SEEDED viewer (auth.setup.ts →
 * `.auth/state.json`, driven by the `chromium` project) exercises the populated
 * feed / bell / decide / mark-all; a distinct EMPTY-state viewer
 * (auth.empty.setup.ts → `.auth/empty-state.json`, driven by `chromium-empty`)
 * proves the single universal "No notifications" empty (spec §V) with both feed
 * halves live and genuinely empty. The empty spec is routed to `chromium-empty`
 * by filename; every other spec runs under `chromium`.
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

// When a CI workflow has already booted a production server on this port
// (E2E_REUSE_SERVER=1), Playwright must reuse it and NOT silently fall back to
// `pnpm dev` — a dev fallback would mask a real failure and cold-boot Turbopack.
// Mirrors the render-smoke suite config.
const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

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
      name: "setup-main",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "setup-empty",
      testMatch: /auth\.empty\.setup\.ts/,
    },
    {
      name: "chromium",
      testIgnore: [/\.setup\.ts/, /notifications-empty\.spec\.ts/],
      use: {
        ...desktopChrome,
        storageState: suitePath("notifications", ".auth/state.json"),
      },
      dependencies: ["setup-main"],
    },
    {
      name: "chromium-empty",
      testMatch: /notifications-empty\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("notifications", ".auth/empty-state.json"),
      },
      dependencies: ["setup-empty"],
    },
  ],
});
