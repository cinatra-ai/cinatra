/**
 * cinatra#1914 — dimensions-only card live-verify.
 *
 * The issue: a card with `measures: []` + one dimension (table chart) saved
 * fine and previewed fine, but on the dashboard the client never issued
 * `/v1/load` at all — spinner, then a permanently blank body with no error
 * and no empty state. Grounding showed the query is fully supported end to
 * end (backend AND the DC client's own validity gate); the silent blank is
 * DC's lazy-load visibility gate never firing, which the grid container now
 * neutralizes by mounting dashboards with DC's `eagerLoad` flag (unless a
 * config explicitly opts out).
 *
 * This spec seeds the issue's EXACT card as its own dashboard
 * (`e2e-1914-dims-only`, see seed-data.ts / auth.setup.ts) and proves on the
 * real stack (Postgres + Better Auth session + DC bundle + Chromium):
 *
 *   1. `/dashboards/e2e-1914-dims-only` is served (no 404/500).
 *   2. The card "das hier" mounts.
 *   3. The client ISSUES `/v1/load` for the dimensions-only query and the
 *      endpoint answers 200 (the issue's defining symptom was the absence
 *      of this request).
 *   4. The table paints real rows (the seeded agent names) — AC-1.
 *   5. The card body is not a silent blank: rows exist, and no page errors
 *      or DC console errors fired — AC-2.
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

import { HYDRATION_TIMEOUT_MS, waitForHydration } from "../config/hydration";
import { DIMS_ONLY_1914_DASHBOARD_ID } from "./seed-data";

const DETAIL_URL = `/dashboards/${DIMS_ONLY_1914_DASHBOARD_ID}`;

test.describe("dimensions-only card renders (cinatra#1914)", () => {
  test("measures:[] + one dimension issues /v1/load and paints table rows", async ({
    page,
  }) => {
    const badConsole: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/@cinatra|drizzle-cube|DashboardStoreProvider|Converting circular/i.test(text)) {
        badConsole.push(text);
      }
    });
    page.on("pageerror", (err: Error) => {
      pageErrors.push(`${err.name}: ${err.message}`);
    });

    // Pre-arm the /v1/load waiter BEFORE navigation and pin it to THIS
    // card's query: the dimensions-only request (`agent_runs.agent_name`,
    // no `agent_runs.count`). The absence of exactly this request was the
    // issue's defining symptom.
    const dimsOnlyLoad = page.waitForResponse(
      (r) => {
        if (!r.url().includes("/api/dashboards/cubejs-api/v1/load")) return false;
        if (r.status() !== 200) return false;
        const q = decodeURIComponent(r.url());
        return q.includes("agent_runs.agent_name") && !q.includes("agent_runs.count");
      },
      { timeout: HYDRATION_TIMEOUT_MS + 30_000 },
    );

    // 1: route resolution.
    const resp = await page.goto(DETAIL_URL);
    expect(resp?.status(), "dims-only detail page should return 200").toBeLessThan(400);
    await waitForHydration(page);

    // 2: page chrome + the card title from the issue.
    await expect(
      page.getByRole("heading", { name: "E2E 1914 dims-only", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("das hier")).toBeVisible();

    // 3: the dimensions-only /v1/load round-trip happened.
    await dimsOnlyLoad;

    // 4: the table paints the seeded agent names — real rows, not a blank.
    const shell = page.locator('[data-cinatra-dashboard-shell="true"]');
    await expect(shell).toBeVisible();
    const table = shell.locator("table").first();
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(table.locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });
    await expect(table.getByText("Test Scrape Agent")).toBeVisible();

    // 5: nothing crashed silently.
    expect(badConsole, "no DC/package console errors").toEqual([]);
    expect(pageErrors, "no uncaught page errors").toEqual([]);
  });
});
