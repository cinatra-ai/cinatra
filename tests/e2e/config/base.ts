// Shared defaults for the per-suite Playwright configs in this directory.
// Each suite keeps its own config (genuinely different web servers, ports,
// projects, and timeouts) but pulls the common bits from here.
import path from "node:path";
import { devices } from "@playwright/test";

// Suite test dirs live one level up (tests/e2e/<suite>). Anchored to this file
// so the paths resolve correctly regardless of cwd or config location.
const E2E_DIR = path.resolve(__dirname, "..");

// Repo root is two levels above tests/e2e. Because these configs no longer sit
// at the repo root, Playwright would otherwise resolve `webServer.cwd`,
// `outputDir`, and the HTML reporter's `outputFolder` relative to THIS config
// directory. Suites anchor those to REPO_ROOT (via the helpers below) so the
// dev server still boots from the repo root and CI uploads the same root-level
// `test-results` / `playwright-report` paths it always has.
export const REPO_ROOT = path.resolve(E2E_DIR, "..", "..");

/** Absolute path inside a suite's dir, e.g. suitePath("rbac", ".auth/state.json"). */
export const suitePath = (suite: string, ...rest: string[]): string =>
  path.join(E2E_DIR, suite, ...rest);

/** Absolute path anchored at the repo root, e.g. repoPath("playwright-report"). */
export const repoPath = (...rest: string[]): string =>
  path.join(REPO_ROOT, ...rest);

/** Failure diagnostics shared by every e2e suite. */
export const baseUse = {
  trace: "retain-on-failure",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
} as const;

export const desktopChrome = devices["Desktop Chrome"];
