/**
 * apiVersion 1.2 analytics dashboard render smoke (cinatra#326).
 *
 * #325 added the `analytics` portlet kind + the PortletHost render path but
 * RECORDED that the full seed→render walk was blocked until #326 enabled
 * apiVersion 1.2 writes. #326 unblocks it: the create/save path now persists an
 * apiVersion 1.2 analytics envelope. This spec proves the other half — a
 * persisted apiVersion 1.2 analytics row OPENS at `/dashboards/[id]` and renders
 * the full interactive drizzle-cube grid through
 * `PortletHost` → `AnalyticsPortletView`, identical to `/agents`.
 *
 * The row is seeded in `auth.setup.ts` (`seedV12AnalyticsDashboard`) as the
 * literal envelope the mutation service's `wrapDcAsV12` emits, and that setup
 * step already ASSERTS the persisted `config_version` is the apiVersion 1.2
 * literal (so this suite covers persist-shape + render together).
 *
 * What it asserts:
 *   1. `/dashboards/[id]` is served (no 500 / no notFound) for the apiVersion
 *      1.2 analytics row.
 *   2. The page chrome renders (the seeded dashboard name).
 *   3. The embedded portlet titles mount (the DC grid mounted through the
 *      analytics view, NOT the legacy read-only branch).
 *   4. The analytics portlet renders BARE — PortletHost does NOT wrap it in the
 *      generic portlet `<Card>` header (`kind@version` chrome) it uses for the
 *      other 9 kinds (cinatra#325 §2b chrome policy).
 *   5. `GET /api/dashboards/cubejs-api/v1/load` returns 200 (the embedded view
 *      reuses the same CubeProvider shell).
 *   6. The bar chart SVG paints at least one `<rect>` (data render).
 *   7. The table portlet shows at least one `<tr>` body row.
 *   8. NO `/api/ai/*` requests (DC's AI surface stays OFF).
 */
import { test, expect, type ConsoleMessage, type Request } from "@playwright/test";

import { HYDRATION_TIMEOUT_MS, waitForHydration } from "../config/hydration";
import { V12_ANALYTICS_DASHBOARD_ID } from "./seed-data";

const DETAIL_URL = `/dashboards/${V12_ANALYTICS_DASHBOARD_ID}`;

test.describe("apiVersion 1.2 analytics /dashboards/[id] render", () => {
  test("renders the embedded DC grid through PortletHost with cube-backed data", async ({ page }) => {
    const badConsole: string[] = [];
    const aiRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/@cinatra|drizzle-cube|DashboardStoreProvider|@nivo|tableRef|Converting circular/i.test(text)) {
        badConsole.push(text);
      }
    });
    page.on("pageerror", (err: Error) => {
      pageErrors.push(`${err.name}: ${err.message}`);
    });
    page.on("request", (r: Request) => {
      if (/\/api\/ai\//.test(r.url())) aiRequests.push(r.url());
    });

    // Pre-arm the cube /v1/load waiter BEFORE navigation (a fast post-warmup
    // response could otherwise land before waitForResponse attaches).
    const cubeLoadResponse = page.waitForResponse(
      (r) => r.url().includes("/api/dashboards/cubejs-api/v1/load") && r.status() === 200,
      { timeout: HYDRATION_TIMEOUT_MS + 30_000 },
    );

    // 1: route resolution — the apiVersion 1.2 row must NOT 404 / 500.
    const resp = await page.goto(DETAIL_URL);
    expect(resp?.status(), "apiVersion 1.2 detail page should return 200").toBeLessThan(400);
    await expect(page).toHaveURL(new RegExp(`${V12_ANALYTICS_DASHBOARD_ID}$`));

    await waitForHydration(page);

    // 2: page chrome (the seeded dashboard name from the PageHeader).
    await expect(
      page.getByRole("heading", { name: "E2E apiVersion 1.2 Analytics", exact: true }),
    ).toBeVisible();

    // 3: the embedded DC portlet titles mounted (proves the analytics view
    // mounted the embedded config, not the "Unsupported dashboard format" card).
    await expect(page.getByText("apiVersion 1.2 top agents")).toBeVisible();
    await expect(page.getByText("apiVersion 1.2 latest runs")).toBeVisible();

    // 4: BARE chrome — the analytics portlet is NOT wrapped in the generic
    // portlet card header PortletHost uses for the other kinds. That header
    // renders the instanceId + a `kind@version` mono badge; for the analytics
    // kind it must be absent (cinatra#325 §2b). The dashboard shell itself is
    // present (the DC grid mounted edge-to-edge).
    await expect(page.locator('[data-cinatra-dashboard-shell="true"]')).toBeVisible();
    await expect(page.getByText("analytics@1.0.0")).toHaveCount(0);

    // 5: cube endpoint round-trip (the embedded view reuses the CubeProvider shell).
    await cubeLoadResponse;

    // 6: bar chart rendered with at least one bar.
    const shell = page.locator('[data-cinatra-dashboard-shell="true"]');
    const firstSvg = shell.locator(".recharts-wrapper svg").first();
    await expect(firstSvg).toBeVisible();
    await expect(firstSvg.locator("rect, path").first()).toBeVisible();

    // 7: table portlet has at least one data row.
    const table = shell.locator("table").first();
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });

    // 8: no AI requests + no package console errors / page crashes.
    expect(aiRequests, "AI surface must stay OFF").toEqual([]);
    expect(badConsole, "no @cinatra/drizzle-cube/DC store errors").toEqual([]);
    expect(pageErrors, "no uncaught page errors").toEqual([]);
  });
});
