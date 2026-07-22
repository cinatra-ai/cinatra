/**
 * cinatra#1911 — executable-surface live-verify.
 *
 * The issue: agent-created dashboards persisted Cube.js queries the v1
 * adapter rejected at render time — the reference dashboard's 6/6 portlets
 * 400'd with `unsupported_query_feature` because they used `timeDimensions`,
 * `inDateRange` and `in`, none of which the adapter executed. The fix widens
 * the v1 executable surface to exactly those features (drizzle-cube supports
 * them natively; only the in-repo gate rejected them).
 *
 * This spec opens the seeded `e2e-1911-exec-surface` dashboard (six cards
 * reproducing the reference dashboard's feature mix, see seed-data.ts) and
 * proves on the real stack (Postgres + Better Auth session + DC bundle +
 * Chromium):
 *
 *   1. `/dashboards/e2e-1911-exec-surface` is served.
 *   2. A timeDimensions (granularity=day) `/v1/load` answers 200 — the
 *      request class that previously ALWAYS 400'd.
 *   3. An `inDateRange` `/v1/load` answers 200 — same.
 *   4. Real rows paint: the `in`-filtered "failed or stopped" card shows the
 *      seeded failed run's agent — AC-#5.
 *   5. No card renders the unsupported-feature copy and nothing crashed.
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

import { HYDRATION_TIMEOUT_MS, waitForHydration } from "../config/hydration";
import { EXEC_SURFACE_1911_DASHBOARD_ID } from "./seed-data";

const DETAIL_URL = `/dashboards/${EXEC_SURFACE_1911_DASHBOARD_ID}`;

test.describe("executable query surface renders (cinatra#1911)", () => {
  test("timeDimensions / inDateRange / in queries load and paint rows", async ({
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

    // Pre-arm the load waiters BEFORE navigation, each pinned to a feature
    // class that used to 400 (these are GET /load?query=<encoded JSON>).
    const timeSeriesLoad = page.waitForResponse(
      (r) => {
        if (!r.url().includes("/api/dashboards/cubejs-api/v1/load")) return false;
        if (r.status() !== 200) return false;
        const q = decodeURIComponent(r.url());
        return q.includes("timeDimensions") && q.includes('"granularity":"day"');
      },
      { timeout: HYDRATION_TIMEOUT_MS + 30_000 },
    );
    const dateWindowLoad = page.waitForResponse(
      (r) => {
        if (!r.url().includes("/api/dashboards/cubejs-api/v1/load")) return false;
        if (r.status() !== 200) return false;
        const q = decodeURIComponent(r.url());
        return q.includes('"operator":"inDateRange"');
      },
      { timeout: HYDRATION_TIMEOUT_MS + 30_000 },
    );
    const inFilterLoad = page.waitForResponse(
      (r) => {
        if (!r.url().includes("/api/dashboards/cubejs-api/v1/load")) return false;
        if (r.status() !== 200) return false;
        const q = decodeURIComponent(r.url());
        return q.includes('"operator":"in"') && q.includes('"failed"');
      },
      { timeout: HYDRATION_TIMEOUT_MS + 30_000 },
    );

    // 1: route resolution.
    const resp = await page.goto(DETAIL_URL);
    expect(resp?.status(), "exec-surface detail page should return 200").toBeLessThan(400);
    await waitForHydration(page);

    // 2: page chrome + the six cards mount.
    await expect(
      page.getByRole("heading", { name: "E2E 1911 executable surface", exact: true }),
    ).toBeVisible();
    for (const title of [
      "Agent runs over time",
      "Run status mix",
      "Top agents by run count",
      "Run activity over time",
      "Runs, last 30 days",
      "Failed or stopped runs by agent",
    ]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }

    // 3: the formerly-rejected request classes all round-trip 200.
    await timeSeriesLoad;
    await dateWindowLoad;
    await inFilterLoad;

    // 4: real rows paint — the `in`-filtered card shows the seeded failed
    //    run's agent (run-fixture-4 → Test Summarize Agent, status=failed).
    const shell = page.locator('[data-cinatra-dashboard-shell="true"]');
    await expect(shell).toBeVisible();
    await expect(shell.getByText("Test Summarize Agent").first()).toBeVisible({
      timeout: 15_000,
    });

    // 5: no card fell back to the unsupported-feature error copy, and
    //    nothing crashed. (Copy markers cover both the old technical reason
    //    and the new product copy.)
    await expect(shell.getByText(/unsupported_query_feature/)).toHaveCount(0);
    await expect(shell.getByText(/not supported by this adapter/)).toHaveCount(0);
    await expect(shell.getByText(/unsupported operator/)).toHaveCount(0);
    expect(badConsole, "no DC/package console errors").toEqual([]);
    expect(pageErrors, "no uncaught page errors").toEqual([]);
  });
});
