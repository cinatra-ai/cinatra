/**
 * Path-gated Playwright config for the Dashboards live-verify smoke.
 *
 * Runs against a real Next.js dev server bound to port 3100 (NOT 3000
 * — keeps local devs free to keep the canonical main server running
 * while CI exercises this). On CI, the workflow at
 * `.github/workflows/dashboard-live-verify.yml` spins up Postgres +
 * Redis service containers and provisions the schema via
 * `cinatra setup branch` before invoking `pnpm test:e2e:dashboards`.
 *
 * Why this exists: dashboards runtime bugs were not caught by the
 * typecheck + unit gate. They were invisible until a real browser hit
 * `/agents` against a real Postgres + a real drizzle-cube/client bundle.
 * This gate runs that walk on every PR touching `packages/dashboards/**`,
 * `packages/sdk-dashboard/**`, or the dashboards API route.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// When the CI workflow boots its own server (a prebuilt standalone prod
// server — see .github/workflows/dashboard-live-verify.yml), it sets
// E2E_REUSE_SERVER=1 so Playwright must NOT manage a server. Mirrors the
// rbac suite: Turbopack `pnpm dev` cold-compiles each route
// on first hit, exhausting the runner mid-suite, and a Playwright-owned dev
// process tree could not be torn down cleanly (the suite ran to the runner's
// hard kill with no report). A prebuilt server serves routes instantly with
// steady memory, and the workflow owns its lifecycle + teardown.
const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("dashboards"),
  outputDir: repoPath("test-results"),
  // 120s per test (up from 60s) to absorb Next.js dev-mode lazy compile
  // of the cube API route on first browser-issued request. The setup
  // project pre-compiles `/v1/meta` via APIRequestContext, but the
  // browser's `POST /v1/load` may still trigger a compile if Next.js
  // doesn't reuse the meta-path compilation. The pre-armed
  // `waitForResponse` in agents.spec.ts has its own budget
  // (HYDRATION_TIMEOUT_MS + 30s — 60s on CI, where hydration is sub-5s
  // against the prebuilt server); this 120s ceiling leaves room for
  // chrome render + portlet mount + final SVG + table assertions on top.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,
  // CI hard cap: convert a hung/slow suite into a fast Playwright failure with a
  // report instead of running to the 30-min GitHub-runner kill (cancelled run).
  // Mirrors the rbac / workflows suites.
  globalTimeout: process.env.CI ? 18 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  // In CI the workflow boots a prebuilt standalone server and sets
  // E2E_REUSE_SERVER=1, so Playwright must NOT own a server (EXTERNAL_SERVER
  // → undefined). Locally, Playwright boots `pnpm dev` under our test port if
  // one isn't already running there; `reuseExistingServer` lets a developer
  // re-run against an already-warm dev server.
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
        storageState: suitePath("dashboards", ".auth/state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
