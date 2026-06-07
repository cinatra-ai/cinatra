// Overlay screenshot harness — capture PNG baselines for the today-line /
// critical-path / planned-vs-actual overlays + the hierarchy rollup expanded /
// collapsed states. Used to close the UI-review PARTIAL on "visual coherence
// under different states" once the baseline run is executed and the PNGs are
// committed (harness alone does NOT close the PARTIAL).
//
// Opt-in by design: gated on `CAPTURE_SCREENSHOTS=1` so the standard CI
// e2e job is unaffected. The seed-data layer reads the same env var to enrich
// the workflow with succeeded/running/failed status-coverage tasks carrying
// actual_start/end timestamps + nonzero planned spans (the actual-bar overlay
// returns null on milestones or missing-actuals — see
// src/components/workflows/workflow-gantt-metrics.ts:computeActualBarMetrics).
//
// To (re-)capture the baseline grid:
//   1. Start a real dev server + Postgres (the existing e2e harness handles this).
//   2. CAPTURE_SCREENSHOTS=1 pnpm test:e2e:workflows -- screenshots.spec.ts
//   3. Inspect the PNGs under __screenshots__/overlay-foundation/ and
//      __screenshots__/planned-actual/ alongside this spec.
//   4. Commit the updated PNGs if intentional; revert otherwise.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { WORKFLOW_ID } from "./seed-data";

const SHOULD_CAPTURE = process.env.CAPTURE_SCREENSHOTS === "1";

const SCREENSHOT_ROOT = path.resolve(__dirname, "__screenshots__");
const SCREENSHOT_DIR_OVERLAY = path.join(
  SCREENSHOT_ROOT,
  "overlay-foundation",
);
const SCREENSHOT_DIR_PLANNED_ACTUAL = path.join(
  SCREENSHOT_ROOT,
  "planned-actual",
);

test.describe("overlay screenshot grid", () => {
  test.skip(!SHOULD_CAPTURE, "set CAPTURE_SCREENSHOTS=1 to capture");

  test.beforeEach(async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);
    // Gate on SVAR client mount.
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();
    // Let the rAF today-line overlay settle.
    await page.waitForTimeout(500);
  });

  // Hero shot: the timeline rendered in month view with all overlays
  // visible together (today-line + critical-path highlight on the dependency
  // chain + summary rollup + ghost actual-bars on the status-coverage tasks).
  test("hero: today-line + critical-path + summary rollup + actuals", async ({ page }) => {
    const gantt = page.locator('[data-testid="workflow-gantt"]');
    await expect(gantt).toBeVisible();
    await gantt.screenshot({
      path: path.join(SCREENSHOT_DIR_OVERLAY, "hero-month-all-overlays.png"),
      animations: "disabled",
    });
  });

  // Today-line under two scales (week vs year). Week view is the
  // tightest scale that still shows the running task, so the today-line
  // cuts visibly through Prototype. Year view widens the scale so the line
  // may fall outside the rendered window (off-range), proving the overlay's
  // `setHidden()` path. Differentiates from the month-view hero shot.
  test("today-line: week (in-range) vs year (likely off-range)", async ({ page }) => {
    const gantt = page.locator('[data-testid="workflow-gantt"]');

    // Week view first — tighter scale, today-line visibly cuts through the
    // running task. Differentiates from the month-view hero shot.
    await page.getByRole("radio", { name: "Week view" }).click();
    await page.waitForTimeout(300);
    await gantt.screenshot({
      path: path.join(SCREENSHOT_DIR_OVERLAY, "today-line-week-view.png"),
      animations: "disabled",
    });

    // Year view — wider scale, today-line position recomputed by the rAF loop.
    await page.getByRole("radio", { name: "Year view" }).click();
    await page.waitForTimeout(300);
    await gantt.screenshot({
      path: path.join(SCREENSHOT_DIR_OVERLAY, "today-line-year-view.png"),
      animations: "disabled",
    });
  });

  // Hierarchy collapsed (single summary rollup bar visible).
  test("hierarchy collapsed", async ({ page }) => {
    const parentRow = page
      .locator('.wx-row[data-id=":phase-1-release"], [data-id=":phase-1-release"].wx-row')
      .first();
    const toggle = parentRow.locator('.wx-toggle-icon').first();
    await toggle.evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(200);

    const gantt = page.locator('[data-testid="workflow-gantt"]');
    await gantt.screenshot({
      path: path.join(SCREENSHOT_DIR_OVERLAY, "hierarchy-collapsed.png"),
      animations: "disabled",
    });
  });

  // Actual-bar ghost overlay: succeeded (within planned), running
  // (clipped to "now"), failed (overran planned end → slip-days > 0).
  // These three statuses are co-rendered when the seed enrichment is on;
  // capture the chart so each ghost is visible.
  test("actual-bar grid: succeeded + running + failed", async ({ page }) => {
    // Ensure the status-coverage tasks rendered.
    await expect(page.locator('[data-task-bar="research"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="prototype"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="audit"]')).toBeVisible();

    // Switch to Week view + collapse the hierarchy so the focus is purely
    // on the three flat status-coverage rows (differentiates from the
    // today-line-week-view shot which has the hierarchy expanded).
    await page.getByRole("radio", { name: "Week view" }).click();
    await page.waitForTimeout(200);
    const parentRow = page
      .locator('.wx-row[data-id=":phase-1-release"], [data-id=":phase-1-release"].wx-row')
      .first();
    const toggle = parentRow.locator('.wx-toggle-icon').first();
    await toggle.evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(200);

    const gantt = page.locator('[data-testid="workflow-gantt"]');
    await gantt.screenshot({
      path: path.join(SCREENSHOT_DIR_PLANNED_ACTUAL, "actual-bar-status-grid.png"),
      animations: "disabled",
    });
  });

  // Close-up on the failed task: the inner `<span.gantt-actual-bar>`
  // overruns the planned end, the title carries the ` · +Nd late` suffix.
  test("failed task close-up (slip-days suffix)", async ({ page }) => {
    const auditBar = page.locator('[data-task-bar="audit"]').locator('xpath=ancestor::*[contains(@class,"wx-bar")][1]').first();
    await expect(auditBar).toBeVisible();
    await auditBar.screenshot({
      path: path.join(SCREENSHOT_DIR_PLANNED_ACTUAL, "failed-task-slip-closeup.png"),
      animations: "disabled",
    });
  });

  // Detail Sheet open on a leaf child to capture the leaf shell +
  // overlay layout coexisting with the Radix Dialog.
  test("detail Sheet over actual-bar overlay", async ({ page }) => {
    await page.locator('.wx-bar[data-id=":research"]').click({ force: true });
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR_PLANNED_ACTUAL, "detail-sheet-over-overlay.png"),
      animations: "disabled",
      fullPage: false,
    });
  });
});
