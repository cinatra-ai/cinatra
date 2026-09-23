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
 * The suite includes static picture fixtures AND mutable database-backed
 * conformance surfaces. Seed capabilities, isolated database state and Redis
 * are required for the latter. CI normally supplies a production standalone
 * server; opt-in partitions verify that server's identity before any tests.
 */
import { isAbsolute, resolve, sep } from "node:path";
import { designPartition } from "../../../src/lib/test-support/design-partition";
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const partition = designPartition();
if (partition) {
  process.env.CINATRA_CONFORMANCE_RUN_ID = partition.runId;
  process.env.E2E_DESIGN_PORT = String(partition.port);
  process.env.E2E_DESIGN_BASE_URL = partition.baseURL;
}
const artifactRoot = process.env.CINATRA_DESIGN_ARTIFACT_ROOT;
if (partition && (!artifactRoot || !isAbsolute(artifactRoot) || resolve(artifactRoot).startsWith(resolve(REPO_ROOT) + sep) || resolve(artifactRoot) === resolve(REPO_ROOT))) {
  throw new Error("partition artifacts require an absolute private directory outside the product checkout");
}
const artifacts = (name: string) => partition ? resolve(artifactRoot!, partition.runId, name) : repoPath(name);

const PORT = Number(process.env.E2E_DESIGN_PORT ?? 3101);
const BASE_URL = process.env.E2E_DESIGN_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("design"),
  globalSetup: partition ? repoPath("tests/e2e/design/partition-setup.ts") : undefined,
  outputDir: artifacts("test-results"),
  shard: partition ? { current: partition.current, total: partition.total } : undefined,
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
  // A concluded failure already makes the gate red; stop dependent browser
  // work after that failure (retries still get their normal opportunity).
  maxFailures: process.env.CI ? 1 : 0,
  // Serial ON PURPOSE, and left serial by the diff-selective runner
  // (scripts/ci/design-select.mjs): the conformance families are NOT read-only
  // pages. They provision one seeded namespace per run (the SEEDED_* exact
  // counts in tests/e2e/design/conformance/contract.ts) and drive real actions
  // through it, so a second worker would race the counts the drivers assert.
  // The selector buys its time back by running FEWER families, never by running
  // the same mutable namespace in parallel. Opt-in partitioning instead uses
  // independent databases, Redis databases, app ports and run namespaces, with
  // one worker in each partition; the default remains this serial run.
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never", outputFolder: artifacts("playwright-report-design") }],
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
        command: `PORT=${PORT} CINATRA_E2E_SETUP_BYPASS=true pnpm dev`,
        cwd: REPO_ROOT,
        url: BASE_URL,
        timeout: 240_000,
        reuseExistingServer: partition ? false : !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      name: "design-fixtures-chromium",
      // Pixel-diff + axe + the assertion-based fixture specs. The
      // conformance dir belongs to the functional-acceptance project below.
      testIgnore: "**/conformance/**",
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      // Manifest-driven functional-acceptance conformance gate (cinatra#985):
      // consumes the pinned conformance manifests and asserts fields/actions/
      // state variants of the covered surfaces on /design-fixtures/conformance.
      // Assertion-based (no pixel baselines) — pixel-diff + axe above stay
      // supporting evidence, never the sole gate.
      name: "design-conformance-functional",
      testMatch: "**/conformance/**/*.spec.ts",
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
