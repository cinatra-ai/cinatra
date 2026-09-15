/**
 * Path-gated Playwright config for the run page's RAIL GEOMETRY reading
 * (cinatra#3225, fix leg 10).
 *
 * The rail's rhythm cannot be proven under jsdom — jsdom lays out no text, so a
 * rail label never wraps there and every reading is the utility tokens read
 * back. This suite measures the rendered boxes in a real browser instead, on a
 * run whose work-step title wraps to three lines, in both palettes.
 *
 * It attaches to an ALREADY RUNNING app (no `webServer`): the run it measures
 * has to exist, which no boot of its own can arrange. Opt-in — the spec
 * self-skips unless E2E_RUN_PAGE_RAIL=1 and E2E_RUN_PAGE_RAIL_PATH are set.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, repoPath, suitePath } from "./base";

const BASE_URL = process.env.E2E_RUN_PAGE_RAIL_BASE_URL ?? "http://localhost:3000";
// The run it measures belongs to a signed-in account. A password is one road in
// (the spec fills the form when E2E_RUN_PAGE_RAIL_EMAIL is given); a session
// already established outside the suite is the other, and this is where it is
// handed over — a Playwright storage-state file, named by path, never inlined.
const STORAGE_STATE = process.env.E2E_RUN_PAGE_RAIL_STORAGE_STATE ?? undefined;

export default defineConfig({
  testDir: suitePath("run-page-rail"),
  outputDir: repoPath("test-results"),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    ...baseUse,
    ...desktopChrome,
    // The drawing is graded on CSS pixels; the frames a proof round shoots are
    // taken at 2x, so the reading is taken at 2x too and nothing is read off a
    // different rasterisation than the pictures.
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 1300 },
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
  },
});
