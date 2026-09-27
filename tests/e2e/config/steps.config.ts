/**
 * Playwright config for the live smoke of the maintained steps in
 * `tests/e2e/steps/` (signing in through the page, the island wait, the run
 * watch, the count reading and navigation): one smoke per step, against a
 * development server.
 *
 * It attaches to an ALREADY RUNNING app and boots none (no `webServer`): the
 * steps drive a booted app the way a picture round does. The global setup
 * probes for a browser and for the server first; without either, every test is
 * skipped and its reason names what is missing, so the suite is safe to run
 * anywhere. The steps' own unit tests run in the root unit tier and need
 * neither (`tests/e2e/steps/__tests__`).
 *
 * Run locally:
 *   pnpm dev                     # in another shell (port 3000)
 *   pnpm test:e2e:steps
 *
 * E2E_STEPS_BASE_URL (or E2E_STEPS_PORT) points it at another server.
 * E2E_STEPS_ISLAND_PATH and E2E_STEPS_RUN_PATH name a page with a review island
 * and a run page on that boot, for the two watching smokes.
 */
import { defineConfig } from "@playwright/test";

import { baseUse, desktopChrome, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_STEPS_PORT ?? 3000);
const BASE_URL = process.env.E2E_STEPS_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("steps", "smoke"),
  outputDir: repoPath("test-results"),
  // The run watch's own bound is five minutes; a smoke that names a run page may use all of it.
  timeout: 420_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],
  globalSetup: suitePath("steps", "smoke", "readiness.global-setup.ts"),
  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "steps",
      testMatch: /steps\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("steps", "smoke", ".auth", "state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
