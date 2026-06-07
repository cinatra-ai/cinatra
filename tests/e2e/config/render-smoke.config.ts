/**
 * Path-gated Playwright config for the all-routes render-smoke suite.
 *
 * One data-driven spec (`tests/e2e/render-smoke/all-routes.spec.ts`) enumerates
 * the route inventory at run time from `find src/app -name page.tsx`, filters to
 * the STATIC routes, and visits each under a PLATFORM-ADMIN storageState with a
 * no-500 / no-error-boundary FLOOR assertion (NOT a behavioral or pixel claim).
 *
 * `CINATRA_E2E_SETUP_BYPASS=true` clears the setup-wizard gate but does NOT
 * authenticate — so the suite runs under the admin session minted by
 * `auth.setup.ts` (saved to .auth/admin-state.json) so that admin-gated routes
 * actually render instead of redirecting.
 *
 * Mirrors the rbac suite config: defaults to port 3000 (the canonical local
 * dev server); override with E2E_PORT / E2E_BASE_URL to point at a clone band.
 *
 * Run locally:
 *   pnpm dev                                # in another shell (port 3000)
 *   CI= pnpm test:e2e:render-smoke          # CI= forces reuseExistingServer
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("render-smoke"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  // Hard cap on the full suite in CI. ~63 static routes × per-route navigation +
  // hydration waits can naturally consume the workflow's shell timeout on a slow
  // runner; the global cap fails-fast with artifacts/logs preserved instead of
  // looking like an unbounded hang. 12 min is generous over the typical runtime.
  globalTimeout: process.env.CI ? 12 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  // When the CI workflow has already booted a server (E2E_REUSE_SERVER=1)
  // Playwright must NOT silently fall back to `pnpm dev` if the external server
  // dies mid-suite — that would mask the real failure and cold-boot Turbopack.
  // Disable webServer entirely in that path; locally, Playwright manages a dev
  // server (with the setup-bypass env so the fresh-instance /setup redirect is
  // cleared) as before.
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
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...desktopChrome,
        storageState: suitePath("render-smoke", ".auth/admin-state.json"),
      },
      testMatch: /all-routes\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
});
