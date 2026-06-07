/**
 * Path-gated Playwright config for the RBAC browser authorization suite
 * (RBAC-UI-04, RBAC-EXT-03).
 *
 * Mirrors the notifications suite config. Defaults to port 3000 (the
 * canonical local dev server); override with E2E_PORT / E2E_BASE_URL to
 * point at a clone band. The unit-level resolver matrix
 * (src/lib/authz/__tests__/resolver-matrix.test.ts, RBAC-UI-05) is the
 * primary CI proof of resolver correctness; this browser suite is the
 * representative end-to-end arm and runs in the full e2e env (Postgres +
 * Redis service containers + a seeded multi-actor fixture).
 *
 * Two setup projects + two chromium projects:
 *   - `setup-member` (auth.setup.ts) creates the non-admin member, the
 *     owned project, and the customer user; saves member state.
 *   - `setup-customer` (auth.customer.setup.ts) signs in as the customer
 *     user and saves their state for the EXT-02 scoped-view test.
 *   - `chromium-member` runs everything EXCEPT the EXT-02 spec under the
 *     member state.
 *   - `chromium-customer` runs ONLY the EXT-02 spec under the customer
 *     state.
 *
 * Run locally:
 *   pnpm dev                       # in another shell (port 3000)
 *   CI= pnpm test:e2e:rbac         # CI= forces reuseExistingServer
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("rbac"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  // Hard cap on the full suite in CI. Without this, a single slow runner +
  // retry-budget exhaustion (per-test 120s × retries × hydration waits)
  // can naturally consume the workflow's 25-min shell timeout — observed
  // a ~30 min CI stall even though the post-merge run on main passed
  // in ~9 min. 10 min is generous over the typical ~7 min suite runtime.
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  // When the CI workflow has already booted a production server (E2E_REUSE_SERVER=1)
  // Playwright must NOT silently fall back to `pnpm dev` if the external server
  // dies mid-suite — that would mask the real failure and burn the suite budget
  // booting Turbopack cold. Disable webServer entirely in that path; locally,
  // Playwright manages a dev server as before.
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
      name: "setup-member",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "setup-customer",
      testMatch: /auth\.customer\.setup\.ts/,
      dependencies: ["setup-member"],
    },
    {
      name: "chromium-member",
      use: {
        ...desktopChrome,
        storageState: suitePath("rbac", ".auth/state.json"),
      },
      // The customer-only spec runs under chromium-customer below.
      testIgnore: /rbac-customer-scoped\.spec\.ts/,
      dependencies: ["setup-member"],
    },
    {
      name: "chromium-customer",
      use: {
        ...desktopChrome,
        storageState: suitePath("rbac", ".auth/customer-state.json"),
      },
      testMatch: /rbac-customer-scoped\.spec\.ts/,
      dependencies: ["setup-customer"],
    },
  ],
});
