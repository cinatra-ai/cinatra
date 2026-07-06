/**
 * /agents tab-bar + route-split live-verify (cinatra#1007).
 *
 * /agents was restructured into two tabs:
 *   - "All Agents" (default) — the run-agent picker, now served AT /agents
 *     (moved from the removed, NOT redirected, /agents/run).
 *   - "Executions" — the top-5-recently-used + 5-latest-run dashboard, moved
 *     from the bare /agents to /agents/executions.
 *
 * What this asserts (the acceptance bar from the issue):
 *   1. /agents renders the All-Agents picker (heading "Run agent", the
 *      redesigned agent cards) with the tab bar showing "All Agents" active.
 *   2. /agents/executions renders the dashboard (heading "Agents", the
 *      recently-used/latest-run portlets) with the tab bar showing
 *      "Executions" active.
 *   3. The tab bar is present + correctly wired on BOTH routes — clicking
 *      "Executions" from /agents navigates to /agents/executions and back.
 *   4. /agents/run no longer resolves (404) — removed, not redirected.
 */
import { expect, test } from "@playwright/test";

import { waitForHydration } from "../config/hydration";

test.describe("/agents tab bar + route split", () => {
  test("/agents renders the All-Agents picker with 'All Agents' active", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    await expect(
      page.getByRole("heading", { name: "Run agent", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const allAgentsTab = page.getByRole("tab", { name: "All Agents" });
    const executionsTab = page.getByRole("tab", { name: "Executions" });
    await expect(allAgentsTab).toBeVisible();
    await expect(executionsTab).toBeVisible();
    await expect(allAgentsTab).toHaveAttribute("data-state", "active");
    await expect(executionsTab).toHaveAttribute("data-state", "inactive");

    // No section rule directly under the page title (issue Part 2, bullet 1)
    // — the tab row's own trailing rule (rendered OUTSIDE the <header>)
    // replaces it (PageHeader divider={false} suppresses its own
    // data-slot="separator" data-major Separator inside <header>).
    await expect(
      page.locator('header [data-slot="separator"][data-major]'),
    ).toHaveCount(0);
  });

  test("/agents/executions renders the dashboard with 'Executions' active", async ({ page }) => {
    await page.goto("/agents/executions", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    await expect(
      page.getByRole("heading", { name: "Agents", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Top 5 recently used agents")).toBeVisible();
    await expect(page.getByText("5 latest run agents")).toBeVisible();

    const allAgentsTab = page.getByRole("tab", { name: "All Agents" });
    const executionsTab = page.getByRole("tab", { name: "Executions" });
    await expect(allAgentsTab).toBeVisible();
    await expect(executionsTab).toBeVisible();
    await expect(allAgentsTab).toHaveAttribute("data-state", "inactive");
    await expect(executionsTab).toHaveAttribute("data-state", "active");
  });

  test("tab bar navigates between /agents and /agents/executions", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    await page.getByRole("tab", { name: "Executions" }).click();
    await page.waitForURL(/\/agents\/executions$/);
    await expect(
      page.getByRole("heading", { name: "Agents", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole("tab", { name: "All Agents" }).click();
    await page.waitForURL(/\/agents$/);
    await expect(
      page.getByRole("heading", { name: "Run agent", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("/agents/run no longer resolves (removed, not redirected)", async ({ page }) => {
    const response = await page.goto("/agents/run", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(404);
  });
});
