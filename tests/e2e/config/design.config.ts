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
 *
 * Workers per family (./design-workers.mjs): the functional-acceptance family
 * runs with several workers in its own project; every other family keeps one.
 */
import { isAbsolute, resolve, sep } from "node:path";
import { designPartition } from "../../../src/lib/test-support/design-partition";
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";
import { FUNCTIONAL_ACCEPTANCE_FAMILY, designWorkers } from "./design-workers.mjs";

const partition = designPartition();
const workers = designWorkers({ partitioned: partition !== undefined });
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
  // In order: an opt-in partition first proves the server is its own, then the
  // seeded fixture namespace is converged ONCE, before any worker starts (see
  // tests/e2e/design/seed-setup.ts for why that matters to parallel workers).
  globalSetup: [
    ...(partition ? [repoPath("tests/e2e/design/partition-setup.ts")] : []),
    repoPath("tests/e2e/design/seed-setup.ts"),
  ],
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
  // Workers per family (cinatra#3770; the number and its measured reason live in
  // ./design-workers.mjs). The functional-acceptance family holds 448 of the
  // 762 tests and about three quarters of the suite's time, so it runs in its
  // own project with several workers, inside this one job and against its one
  // build. Its tests share no server-side state a second worker could race:
  // each driver answers its own writes at the network boundary of its own page,
  // and the one shared state, the run's seeded fixture namespace (the SEEDED_*
  // exact counts in tests/e2e/design/conformance/contract.ts), is converged once
  // by the global setup above; after that every provisioning call finds it
  // converged and writes nothing. The family is split per surface: one surface's
  // tests run in order on one worker.
  //
  // Every other family keeps ONE worker with its tests in order: its project
  // sets `fullyParallel: false` and `workers: 1`, so the pixel comparisons stay
  // serial. The cap below is the functional-acceptance number, so no more
  // browsers than that run at once. Opt-in partitioning instead uses
  // independent databases, Redis databases, app ports and run namespaces, with
  // one worker for every family in each partition.
  fullyParallel: false,
  workers: workers.total,

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
      // conformance dir belongs to the two conformance projects below.
      testIgnore: "**/conformance/**",
      // Serial: one worker, every family's tests in order.
      fullyParallel: false,
      workers: workers.serial,
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      // The other conformance families (the header rule, the primitive
      // geometry and waves, render parity with its pixel comparison, the tab
      // select): serial, one worker, every family's tests in order.
      name: "design-conformance-functional",
      testMatch: "**/conformance/**/*.spec.ts",
      testIgnore: FUNCTIONAL_ACCEPTANCE_FAMILY,
      fullyParallel: false,
      workers: workers.serial,
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
      // supporting evidence, never the sole gate. Parallel over several
      // workers, split per surface (the spec declares that boundary).
      name: "design-functional-acceptance",
      testMatch: FUNCTIONAL_ACCEPTANCE_FAMILY,
      fullyParallel: true,
      workers: workers.functionalAcceptance,
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
