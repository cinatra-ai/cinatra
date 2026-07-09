/**
 * Path-gated Playwright config for the warm dev-session HMR smoke (cinatra#1093).
 *
 * Unlike the render-smoke / dashboards suites (which run against a PRODUCTION
 * build), this suite MUST run against `pnpm dev` (Turbopack): it exists to catch
 * the HMR-re-evaluation-over-framework-locked-objects regression class
 * (cinatra#1068) that only manifests in a WARM dev session after a true
 * recompile. It reuses the render-smoke PLATFORM-ADMIN storageState
 * (auth.setup.ts) so the server-action surfaces actually render.
 *
 * In CI the dev server is booted EXTERNALLY (E2E_REUSE_SERVER=1) so its log can
 * be captured to a file and scanned by scripts/ci/hmr-smoke-scan.mjs, and so the
 * workflow — not Playwright — owns the dev process's lifecycle (a
 * Playwright-managed `pnpm dev` left an untearable process tree in an earlier
 * dashboards attempt). Locally, Playwright manages the dev server.
 *
 * Run locally:
 *   pnpm dev                                  # in another shell (port 3000)
 *   CI= E2E_REUSE_SERVER=1 pnpm test:e2e:dev-hmr-smoke
 */
import { defineConfig } from "@playwright/test";

import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("dev-hmr-smoke"),
  outputDir: repoPath("test-results"),
  // A warm `pnpm dev` (Turbopack) cold-compiles each route on FIRST hit
  // (~15-40s each — the same first-hit dev-compile cost the WP UAT stream route
  // shows), and this single test walks the bounded surface set TWICE (warm +
  // post-recompile). 180s timed the walk out before it could assert the floor;
  // give the cold-compile walk a real budget. A genuine #1068 regression returns
  // HTTP 500 IMMEDIATELY (checkSurface), so a generous timeout does not mask it —
  // it only absorbs the unavoidable dev cold-compile cost.
  timeout: 600_000,
  expect: { timeout: 15_000 },
  // A warm-dev regression is deterministic; a retry only masks a genuine
  // post-recompile 500. Keep 0 retries so the report is honest.
  retries: 0,
  fullyParallel: false,
  workers: 1,
  globalTimeout: process.env.CI ? 18 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
    // Bound a single cold-compiling navigation so one pathological route fails
    // with an actionable "[phase] /route: navigation threw (...)" via
    // checkSurface, instead of silently eating the whole test budget as an
    // opaque test timeout. Generous enough for a cold Turbopack first-hit.
    navigationTimeout: 90_000,
  },

  // In CI the workflow boots `pnpm dev` externally (to capture + scan its log
  // and to own teardown). Locally, Playwright manages a dev server with the
  // setup-bypass env so the fresh-instance /setup redirect is cleared.
  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        command: `PORT=${PORT} CINATRA_E2E_SETUP_BYPASS=true pnpm dev`,
        cwd: REPO_ROOT,
        url: BASE_URL,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      // Reuse the render-smoke platform-admin storageState setup verbatim (no
      // duplication): it signs up + promotes a smoke admin and persists the
      // cookie to tests/e2e/render-smoke/.auth/admin-state.json.
      name: "setup",
      testDir: suitePath("render-smoke"),
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...desktopChrome,
        storageState: suitePath("render-smoke", ".auth/admin-state.json"),
      },
      testMatch: /dev-hmr-smoke\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
});
