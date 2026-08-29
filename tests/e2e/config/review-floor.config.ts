/**
 * Path-gated Playwright config for THE REVIEW FLOOR's live walk (cinatra#3080,
 * epic #3023) — Comment · Regenerate · Continue on every pending review.
 *
 * A LIVE spec, like its `agents-run` siblings: it needs the running app, the
 * canonical schema, a real authenticated session and the real review store, so
 * it is not a per-PR gate. What is per-PR is everything BELOW the browser — the
 * floor's vocabulary, the one decision entry's roads and refusals, and the
 * real-store invariants (`pnpm test:review-floor`).
 *
 *   pnpm exec playwright test --config tests/e2e/config/review-floor.config.ts
 *
 * The suite self-skips per test when this instance cannot seed a gate (no
 * `E2E_USER_ID` / `E2E_ORG_ID`, or no readable artifact revision to pin), so a
 * stack that is not set up for it reports honestly rather than failing on the
 * harness.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_REVIEW_FLOOR_PORT ?? 3000);
const BASE_URL = process.env.E2E_REVIEW_FLOOR_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: suitePath("review-floor"),
  outputDir: repoPath("test-results"),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // Strictly serial: every test mints a real run and a real gate, and the
  // stale-decision case deliberately races two tabs on one gate.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],
  use: {
    ...baseUse,
    ...desktopChrome,
    baseURL: BASE_URL,
  },
  projects: [{ name: "review-floor" }],
});
