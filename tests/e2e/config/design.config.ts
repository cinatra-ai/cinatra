/**
 * Playwright harness for the `/design-fixtures/*` design-conformance routes.
 *
 * Why this exists: the shipped components need automated conformance coverage
 * against the ratified drawings, caught by CI instead of by review alone.
 *
 * ASSERTION-BASED, END TO END (cinatra#3189). This config used to carry a
 * pixel-diff + axe gate over one route, `/design-fixtures` — the primitives
 * catalog — whose committed light/dark baselines were then cited as proof that
 * the primitives conform. They never proved that: a baseline only proves the
 * page renders the same as last time, and the catalog was a second copy of the
 * design system rather than the design system itself. The drawings are the
 * source of truth; everything the catalog carried was audited into them and
 * the page removed. What remains here asserts named clauses against the pinned
 * conformance manifests and the real components.
 *
 * The harness routes are STATIC (no DB queries). `cinatra setup branch` is NOT
 * required before these tests run in CI. The `webServer` block below boots
 * `pnpm dev` directly on a dedicated port.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const PORT = Number(process.env.E2E_DESIGN_PORT ?? 3101);
const BASE_URL = process.env.E2E_DESIGN_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("design"),
  outputDir: repoPath("test-results"),
  // A first assertion can take a moment on a cold dev server.
  timeout: 120_000,
  // Snapshot plumbing for the ONE remaining snapshot consumer: the opt-in
  // visual layer of the render-parity spec (RENDER_PARITY_VISUAL=1). Single
  // baseline per surface — strip the per-project / per-platform suffix
  // Playwright normally appends so the same PNG is consulted on macOS dev and
  // Linux CI; the diff threshold absorbs font-hinting drift between OSes.
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    timeout: 15_000,
    // 0.5% of pixels OR 800 absolute pixels — whichever is smaller — is the
    // tolerated drift, which absorbs AA font-hinting noise between macOS dev
    // and Linux CI. Regenerable supporting evidence, never a gate: the
    // DOM-normalized parity assertion is what actually fails a regression.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      maxDiffPixels: 800,
      animations: "disabled",
      caret: "hide",
    },
  },
  retries: process.env.CI ? 1 : 0,
  // Serial ON PURPOSE, and left serial by the diff-selective runner
  // (scripts/ci/design-select.mjs): the conformance families are NOT read-only
  // pages. They provision one seeded namespace per run (the SEEDED_* exact
  // counts in tests/e2e/design/conformance/contract.ts) and drive real actions
  // through it, so a second worker would race the counts the drivers assert.
  // The selector buys its time back by running FEWER families, never by running
  // the same families in parallel; a workers knob here would need a read-only
  // proof this suite cannot give today.
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
    // Video capture adds no signal to an assertion-based suite and only bloats
    // artifacts, so opt out of the shared `retain-on-failure` default.
    video: "off",
    // Deterministic viewport so geometry assertions are stable.
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
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      name: "design-fixtures-chromium",
      // The per-surface assertion specs that sit directly under tests/e2e/design
      // (app shell, agents card, marketplace cards, run-step rail). The
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
      // Assertion-based (no pixel baselines): the gate reads the pinned
      // manifests generated from the drawings, so a clause can only pass by
      // being true of the real component.
      name: "design-conformance-functional",
      testMatch: "**/conformance/**/*.spec.ts",
      use: {
        ...desktopChrome,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
