/**
 * Playwright pixel-diff + axe-core harness for the `/design-fixtures` route.
 *
 * Why this exists: the design fixture route needs automated visual regression
 * and accessibility coverage so regressions are caught by CI instead of manual
 * review alone.
 *
 * Scope: ONE route (`/design-fixtures`), TWO themes (light + dark), full-page
 * screenshots committed under `tests/e2e/design/__screenshots__/<name>-{light,dark}.png`.
 * axe-core gate: zero `serious` or `critical` violations on `/design-fixtures`
 * (NOT site-wide).
 *
 * The route is STATIC (no DB queries). `cinatra setup branch` is NOT required
 * before this test runs in CI. The `webServer` block below boots `pnpm dev`
 * directly on a dedicated port.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const PORT = Number(process.env.E2E_DESIGN_PORT ?? 3101);
const BASE_URL = process.env.E2E_DESIGN_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("design"),
  outputDir: repoPath("test-results"),
  // Visual snapshots can take a moment on a cold dev server.
  timeout: 120_000,
  // Single baseline per surface — strip the per-project / per-platform suffix
  // Playwright normally appends so the same PNG is consulted on macOS dev and
  // Linux CI. The committed baseline is portable; the diff threshold below
  // absorbs font-hinting drift between OSes.
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    timeout: 15_000,
    // Pixel-diff threshold:
    //   0.5% of pixels OR 800 absolute pixels — whichever is smaller — is
    //   the tolerated drift before we treat it as a real regression. This
    //   absorbs AA font hinting noise between macOS dev and Linux CI.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      maxDiffPixels: 800,
      // Avoid animations flickering the diff.
      animations: "disabled",
      caret: "hide",
    },
  },
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never", outputFolder: repoPath("playwright-report-design") }],
      ]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
    // Pixel-diff suite: video capture adds no signal and only bloats artifacts,
    // so opt out of the shared `retain-on-failure` default.
    video: "off",
    // Deterministic viewport so baselines are stable.
    viewport: { width: 1280, height: 900 },
  },

  // In CI the workflow prebuilds + serves the standalone PRODUCTION server
  // (design-visual-verify.yml) and sets E2E_REUSE_SERVER=1 — post-cutover the
  // `pnpm dev` cold-compile boot of the app + the 79 cloned extensions
  // (transpilePackages) exceeds any practical webServer timeout, so CI must not
  // boot it here. Locally (no E2E_REUSE_SERVER), `pnpm dev` is fine.
  webServer: process.env.E2E_REUSE_SERVER
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
      name: "design-fixtures-chromium",
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
