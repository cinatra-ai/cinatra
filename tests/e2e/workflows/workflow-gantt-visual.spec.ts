/**
 * Visual baseline (upload-artifact-only) for the workflow detail Gantt panel.
 *
 * NOTE — Hard visual-regression gating requires e2e seed determinism. The
 * current workflow seed (tests/e2e/workflows/seed-data.ts) is `Date.now()`-
 * seeded; committed pixel baselines would drift on every run. This spec is
 * therefore a SOFT BASELINE: it captures screenshots of the Gantt panel in
 * both themes and uploads them as a CI artifact (a reviewer aid), but it
 * does NOT pixel-diff against committed baselines and it does NOT fail CI on
 * visual difference. If hard visual gating is introduced later, e2e seed
 * determinism MUST land first.
 */
import { test, expect } from "@playwright/test";

import { WORKFLOW_ID } from "./seed-data";

test.describe("workflow detail Gantt panel — visual baseline (upload-only)", () => {
  test("light theme screenshot of the Gantt panel is captured", async ({ page }) => {
    // next-themes persists the chosen theme in localStorage; setting it
    // BEFORE the first navigation guarantees the React tree mounts with the
    // desired theme (and therefore that `WorkflowGantt` picks the matching
    // `Willow` / `WillowDark` wrapper via `useTheme().resolvedTheme`). The
    // alternative — toggling the `<html class="dark">` post-mount — captures
    // dark tokens but misses the SVAR theme-class swap.
    // The cinatra app registers `["cinatra", "dark"]` as next-themes values
    // (see src/app/providers.tsx). The "light" theme key is `"cinatra"`.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("theme", "cinatra");
      } catch {
        /* private mode — best-effort */
      }
    });
    await page.goto(`/workflows/${WORKFLOW_ID}`);

    // Gate on SVAR client mount before screenshotting — otherwise we capture
    // the loading state and the artifact is useless for reviewers.
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();

    const panel = page.getByTestId("workflow-gantt");
    await expect(panel).toBeVisible();

    await page.screenshot({
      path: `playwright-report/gantt-light-${WORKFLOW_ID}.png`,
      fullPage: false,
      clip: await panel.boundingBox().then((box) => box ?? undefined),
    });

    // The assertion is the captured-evidence step itself. We deliberately do
    // NOT call expect(...).toMatchSnapshot — see the NOTE block above.
    expect(true).toBe(true);
  });

  test("dark theme screenshot of the Gantt panel is captured", async ({ page }) => {
    // Pre-seed next-themes so `WorkflowGantt` mounts with `WillowDark` (the
    // component picks the theme wrapper from `useTheme().resolvedTheme` at
    // render time, NOT from later class mutations).
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("theme", "dark");
      } catch {
        /* private mode — best-effort */
      }
    });
    await page.goto(`/workflows/${WORKFLOW_ID}`);

    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();
    const panel = page.getByTestId("workflow-gantt");
    await expect(panel).toBeVisible();

    await page.screenshot({
      path: `playwright-report/gantt-dark-${WORKFLOW_ID}.png`,
      fullPage: false,
      clip: await panel.boundingBox().then((box) => box ?? undefined),
    });

    expect(true).toBe(true);
  });
});
