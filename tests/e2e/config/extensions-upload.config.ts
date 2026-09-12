/**
 * Path-gated Playwright config for the Upload Extension browser walk
 * (cinatra#3204 criterion 34).
 *
 * Runs the two upload roads against a real Next.js server: the File tab reading
 * a package archive of each live kind and configuring its install scope through
 * the store's own panel, and the GitHub tab stating its precondition.
 *
 * The port is deliberately NOT 3000 — a lane's own dev boot owns its slot and
 * this suite is pointed at it with `E2E_BASE_URL` / `E2E_REUSE_SERVER=1`.
 */
import path from "node:path";

import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, suitePath, REPO_ROOT, repoPath } from "./base";

const PORT = Number(process.env.E2E_PORT ?? 3101);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("extensions-upload"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: 1,
  globalTimeout: process.env.CI ? 18 * 60_000 : undefined,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },
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
        env: {
          // The upload road WRITES: it stages the supplied bytes and then
          // materializes them into the extension store. Both live under the
          // host's extension data root, whose container default is /data — a
          // path a test runner does not have. Naming a writable root here is
          // what lets this suite measure a completed install anywhere instead
          // of a permission error (the snapshot root follows this one).
          CINATRA_EXTENSION_DATA_ROOT: path.join(
            REPO_ROOT,
            ".e2e-extension-data",
            "extensions",
          ),
        },
      },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...desktopChrome,
        storageState: suitePath("extensions-upload", ".auth/admin-state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
