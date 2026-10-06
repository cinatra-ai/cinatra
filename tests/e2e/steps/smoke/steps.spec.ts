/**
 * One live smoke per maintained step, against a running development server.
 *
 * Each smoke drives the real app through the step the way a picture round does,
 * and asserts what the step guarantees there. Two of them need a page the boot
 * may not have: E2E_STEPS_ISLAND_PATH names a page with a review island and
 * E2E_STEPS_RUN_PATH a run page. Without them, those smokes watch a page that
 * has neither for a short bound and assert the other side of the guarantee: the
 * frame taken at the bound, and one line that says the wait ran out.
 *
 * Without a browser or a development server every test here is skipped, and its
 * reason names which one is missing (see `readiness.ts`).
 */
import { existsSync } from "node:fs";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { waitForHydration } from "../../config/hydration";
import { createSignInBudget, navigateTo, readCount, signInThroughPage, waitForIsland, watchRun } from "../index.mjs";
import { STEPS_CREDENTIALS, readinessGap } from "./readiness";

const gap = readinessGap();
test.skip(gap !== null, gap ?? "");

/** A page every signed-in account is shown, and a page its navigation leads to. */
const START_PATH = "/agents";
const TARGET_PATH = "/chat";
const ISLAND_PATH = process.env.E2E_STEPS_ISLAND_PATH ?? "";
const RUN_PATH = process.env.E2E_STEPS_RUN_PATH ?? "";
/** The bound for a watch on a page that has nothing to watch. */
const SHORT_BOUND_MS = 3_000;

function recorder(): { lines: string[]; record: (line: string) => void } {
  const lines: string[] = [];
  return { lines, record: (line) => void lines.push(line) };
}

/** A shutter that takes a screenshot into this test's output folder. */
function shutterFor(page: Page, testInfo: TestInfo) {
  return async ({ step, state }: { step: string; state: string }): Promise<string> => {
    const path = testInfo.outputPath(`${step}-${state.replace(/[^a-z0-9]+/gi, "-")}.png`);
    await page.screenshot({ path });
    return path;
  };
}

test.describe("signing in through the page", () => {
  // A context with no session: the step signs in itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signInThroughPage signs the smoke account in once, and writes no credential", async ({ page }) => {
    const { lines, record } = recorder();
    const budget = createSignInBudget();
    const result = await signInThroughPage(page, { credentials: { ...STEPS_CREDENTIALS }, budget, record });
    expect(result.status).toBe(200);
    expect(budget.spent).toBe(1);
    for (const line of lines) {
      const leaks = line.includes(STEPS_CREDENTIALS.email) || line.includes(STEPS_CREDENTIALS.password);
      expect(leaks, "a line the step wrote carries a credential").toBe(false);
    }
  });
});

test("waitForIsland takes its frame and writes one line", async ({ page }, testInfo) => {
  await page.goto(ISLAND_PATH || START_PATH);
  const { lines, record } = recorder();
  const shutter = shutterFor(page, testInfo);
  const result = ISLAND_PATH
    ? await waitForIsland(page, { record, shutter })
    : await waitForIsland(page, { record, shutter, bound: SHORT_BOUND_MS });
  expect(existsSync(result.path), "the frame was not written").toBe(true);
  expect(lines).toHaveLength(1);
  if (ISLAND_PATH) {
    expect(result).toMatchObject({ state: "loaded", settled: true });
  } else {
    expect(result).toMatchObject({ state: "absent", settled: false });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SHORT_BOUND_MS);
  }
});

test("watchRun keeps its watch to the bound and takes its frame", async ({ page }, testInfo) => {
  await page.goto(RUN_PATH || START_PATH);
  const { lines, record } = recorder();
  const shutter = shutterFor(page, testInfo);
  const result = RUN_PATH
    ? await watchRun(page, { record, shutter })
    : await watchRun(page, { record, shutter, bound: SHORT_BOUND_MS });
  expect(existsSync(result.path), "the frame was not written").toBe(true);
  expect(lines).toHaveLength(1);
  if (RUN_PATH) {
    expect(result.settled, `the run did not settle: ${result.state}`).toBe(true);
  } else {
    expect(result).toMatchObject({ state: "absent", settled: false });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SHORT_BOUND_MS);
  }
});

test("readCount records a count that held still, zero included", async ({ page }) => {
  await page.goto(START_PATH);
  await waitForHydration(page);
  const { lines, record } = recorder();
  const links = await readCount(page, { selector: `a[href="${TARGET_PATH}"]`, record });
  expect(links.count).toBeGreaterThan(0);
  const none = await readCount(page, { selector: "[data-steps-smoke-never-drawn]", record });
  expect(none.count).toBe(0);
  expect(lines).toHaveLength(2);
});

test("navigateTo reaches a page through the app's own navigation", async ({ page }) => {
  await page.goto(START_PATH);
  await waitForHydration(page);
  const { lines, record } = recorder();
  const result = await navigateTo(page, { path: TARGET_PATH, record });
  expect(result).toMatchObject({ path: TARGET_PATH, from: START_PATH, pressed: true });
  expect(new URL(page.url()).pathname).toBe(TARGET_PATH);
  expect(lines).toHaveLength(1);
});
