/**
 * Path-gated Playwright config for the WordPress settings-catalog UAT
 * (cinatra-ai/cinatra#2022 S7 — "Settings catalog viewer + health badges
 * verified on a live rendered build").
 *
 * Proves the connector's "Site tools & access" card against a REAL rendered
 * build: the real host reads (`listInstanceServers` / `readInstanceToolPolicy`),
 * the real connector server components, and real client hydration. Nothing is
 * stubbed or route-intercepted — the badge state space is reached by seeding
 * the two persisted stores the card reads (see ../wp-settings-catalog/fixtures.ts).
 *
 * Mirrors the rbac + render-smoke configs: defaults to port 3000 (the canonical
 * local dev server); override with E2E_PORT / E2E_BASE_URL to point at a clone
 * band or a lane-scoped server.
 *
 * PRODUCTION-EQUIVALENT RUN (what the acceptance evidence was captured on, and
 * what CI should use) — the same shape as the RBAC gate's job:
 *
 *   pnpm build
 *   cp -r .next/static .next/standalone/.next/static
 *   cp -r public .next/standalone/public
 *   cp .env.local .next/standalone/.env.local     # standalone reads its OWN cwd
 *   (cd .next/standalone && PORT=3000 HOSTNAME=127.0.0.1 \
 *      CINATRA_E2E_SETUP_BYPASS=true node server.js &)
 *   # wait for /api/auth/get-session to return 200 (the instrumentation hook
 *   # provisions the cinatra schema on first query)
 *   E2E_REUSE_SERVER=1 pnpm test:e2e:wp-settings-catalog
 *
 * TWO ENVIRONMENT FACTS, each of which surfaces as a confusing "Connections tab
 * not found" rather than as itself:
 *
 *   • CINATRA_E2E_SETUP_BYPASS=true is REQUIRED on the PRODUCTION server too,
 *     not only on the `pnpm dev` fallback below. A freshly provisioned instance
 *     has no identity / Nango / OpenAI rows, so the app shell redirects every
 *     authenticated route to /setup and the suite lands on the setup WIZARD —
 *     whose progress rail carries its own "Connections" step, so even the
 *     failure message points at the wrong element. `isSetupWizardComplete()`
 *     honours the flag under NODE_ENV=production by design.
 *   • The port must be one the auth config TRUSTS. Better Auth answers
 *     `403 INVALID_ORIGIN` for an untrusted origin, which shows up as a
 *     sign-up/sign-in failure inside the setup project. Match E2E_PORT to an
 *     origin the server actually trusts instead of picking a free port.
 *
 * Run locally against a dev server instead:
 *   pnpm dev                                   # in another shell (port 3000)
 *   CI= pnpm test:e2e:wp-settings-catalog      # CI= forces reuseExistingServer
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("wp-settings-catalog"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // Serial: every test re-seeds the SHARED fixture rows immediately before it
  // navigates (the health-refresh repair documented in fixtures.ts). Parallel
  // workers would interleave those writes with each other's renders.
  fullyParallel: false,
  workers: 1,
  // Hard cap so a stuck run ends itself WITH a reporter summary instead of
  // being killed by the job timeout with no failing test name (the lesson the
  // wp-drupal-uat config records at length).
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
    // Bound every action/navigation so a step that never becomes actionable
    // ERRORS instead of silently hanging to the per-test ceiling.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  // When a workflow (or a lane) has already booted a production server,
  // Playwright must NOT silently fall back to `pnpm dev` if that server dies
  // mid-suite — that would mask the real failure AND swap the
  // production-equivalent surface for a dev one without saying so.
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
        storageState: suitePath("wp-settings-catalog", ".auth/admin-state.json"),
      },
      testMatch: /settings-catalog\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
});
