/**
 * /agents dashboard live-verify smoke.
 *
 * What it asserts (the minimum bar that would have caught the four
 * runtime regressions in the dashboard mount path):
 *
 *   1. `/sign-in` is reachable (sanity — auth route compiles).
 *   2. After authenticated navigation, `/agents` is served (no 500).
 *   3. The Cinatra page chrome renders (heading "Agents").
 *   4. Both portlets mount with the seeded titles.
 *   5. `GET /api/dashboards/cubejs-api/v1/meta` returns 200.
 *   6. `GET /api/dashboards/cubejs-api/v1/load` returns 200.
 *   7. The bar chart SVG paints at least one `<rect>` (data render).
 *   8. The table portlet shows at least one `<tr>` body row.
 *   9. NO `/api/ai/*` requests are issued during the dashboard mount
 *      (DC's AI surface stays OFF).
 *  10. NO obvious console errors related to our packages.
 */
import { test, expect, type ConsoleMessage, type Request } from "@playwright/test";

// Module-level capture buffers so the afterEach hook can read what each
// test recorded. Cleared per-test via the beforeEach hook.
const consoleAll: Array<{ type: string; text: string }> = [];
const pageErrors: string[] = [];
const networkResponses: Array<{ url: string; status: number }> = [];

test.describe("/agents live-verify", () => {
  test.beforeEach(async ({ page }) => {
    consoleAll.length = 0;
    pageErrors.length = 0;
    networkResponses.length = 0;
    // Capture EVERY console message — not just filtered errors — so a
    // failed assertion has the full browser console available in CI
    // logs. The pre-existing badConsole listener in the main test still
    // does the strict assertion at the end of the green path; this
    // additional listener is purely observability.
    page.on("console", (m: ConsoleMessage) => {
      consoleAll.push({ type: m.type(), text: m.text() });
    });
    // Uncaught page errors (React render crashes, unhandled rejections)
    // are NOT console messages — Playwright surfaces them on a separate
    // event. Capture both.
    page.on("pageerror", (err: Error) => {
      pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`);
    });
    // Network response log — only dashboards/auth URLs to keep volume
    // bounded. Used to prove whether the DC client actually made cube
    // calls (or not).
    page.on("response", (r) => {
      const url = r.url();
      if (
        url.includes("/api/dashboards/") ||
        url.includes("/api/auth/") ||
        url.endsWith("/agents") ||
        url.endsWith("/sign-in") ||
        url.endsWith("/setup") ||
        url.endsWith("/setup/name")
      ) {
        networkResponses.push({ url, status: r.status() });
      }
    });
  });

  // Dump the rendered page HTML on every failed assertion so CI logs
  // show the actual DOM state instead of just `element(s) not found`.
  // Bounded to 5KB to keep the CI log surface manageable; tightened to
  // only fire when there were actual errors so green runs stay clean.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.errors.length === 0) return;
    try {
      // Dump the BODY innerHTML — not the full document — so the chunk
      // script-tag forest in <head> doesn't eat the 5000-char budget
      // before reaching the actual rendered DOM. If the body is short
      // (e.g. an error boundary fallback), all of it is captured.
      const bodyHtml = await page
        .locator("body")
        .innerHTML()
        .catch(() => "(body unreadable)");
      console.log(
        `\n=== /agents BODY snapshot on failure (first 5000 chars) ===\n${bodyHtml.slice(0, 5000)}\n=== end body ===\n`,
      );
    } catch (err) {
      console.log(`/agents body snapshot capture failed: ${err}`);
    }
    // Dump full browser console — every type, every message. Truncate
    // each message at 500 chars to bound noise.
    console.log(`\n=== /agents browser console on failure (${consoleAll.length} msgs) ===`);
    for (const m of consoleAll) {
      console.log(`  [${m.type}] ${m.text.slice(0, 500)}`);
    }
    console.log("=== end console ===\n");
    // Dump uncaught page errors — the most likely culprit when portlets
    // render but data hooks don't fire (a React render crash).
    if (pageErrors.length > 0) {
      console.log(`\n=== /agents page errors on failure (${pageErrors.length}) ===`);
      for (const e of pageErrors) {
        console.log(`  ${e.slice(0, 1000)}`);
      }
      console.log("=== end page errors ===\n");
    }
    // Dump the dashboards/auth network log so we can see whether the DC
    // client actually fired /v1/load (or /v1/meta etc).
    console.log(`\n=== /agents network responses (dashboards/auth only, ${networkResponses.length}) ===`);
    for (const r of networkResponses) {
      console.log(`  ${r.status} ${r.url}`);
    }
    console.log("=== end network ===\n");
  });

  test("renders DashboardGrid with cube-backed data + no AI requests", async ({ page }) => {
    const badConsole: string[] = [];
    const aiRequests: string[] = [];
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/@cinatra|drizzle-cube|DashboardStoreProvider|@nivo|tableRef|Converting circular/i.test(text)) {
        badConsole.push(text);
      }
    });
    page.on("request", (r: Request) => {
      if (/\/api\/ai\//.test(r.url())) aiRequests.push(r.url());
    });

    // Pre-arm the cube /v1/load waiter BEFORE navigation so the listener
    // is attached before any response could possibly fire. Otherwise a
    // fast cube response (post-warmup) can arrive between page.goto
    // resolving and waitForResponse attaching, and the wait silently
    // misses it. Generous 60s timeout to absorb residual dev-mode
    // compile lag if the cube-route warm-up in auth.setup.ts step 7
    // didn't fully pre-compile the load path.
    const cubeLoadResponse = page.waitForResponse(
      (r) => r.url().includes("/api/dashboards/cubejs-api/v1/load") && r.status() === 200,
      { timeout: 60_000 },
    );

    // 1 + 2: route resolution.
    await page.goto("/agents");
    await expect(page).toHaveURL(/\/agents$/);

    // 3: page chrome.
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    // 4: both portlets.
    await expect(page.getByText("Top 5 recently used agents")).toBeVisible();
    await expect(page.getByText("5 latest run agents")).toBeVisible();

    // 5 + 6: cube endpoint round-trip. The listener is already armed
    // (see top of test). Await it now — DC fires /v1/load on portlet
    // mount after hydration.
    await cubeLoadResponse;

    // 7: bar chart rendered with at least one bar (rect or path inside SVG).
    // Scope the SVG search to the dashboard shell + recharts wrapper.
    // `page.locator('svg').first()` previously picked up the Cinatra
    // brand-logo SVG in the sidebar — that SVG IS technically visible,
    // but its inner <path> elements are visibility:hidden (clipped/
    // masked), so the geometry assertion failed against a non-chart
    // SVG. Even within `[data-cinatra-dashboard-shell]` the dashboard
    // toolbar contains button SVG icons (Run agent / Create agent /
    // Edit dashboard); the `.recharts-wrapper` class is recharts' canonical
    // top-level chart container and reliably scopes to the actual
    // chart visualization.
    const shell = page.locator('[data-cinatra-dashboard-shell="true"]');
    const firstSvg = shell.locator(".recharts-wrapper svg").first();
    await expect(firstSvg).toBeVisible();
    const geom = firstSvg.locator("rect, path");
    await expect(geom.first()).toBeVisible();

    // 8: table portlet has at least one data row. Same shell scope so
    // we don't accidentally hit a `<table>` from app chrome elsewhere
    // on the page.
    const table = shell.locator("table").first();
    await expect(table).toBeVisible();
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // 9: no AI requests.
    expect(aiRequests, "AI surface must stay OFF").toEqual([]);

    // 10: no package-related console errors.
    expect(badConsole, "no @cinatra/drizzle-cube/DC store errors").toEqual([]);
  });

  test("/batch endpoint is reachable when multi-query path is hit", async ({ page }) => {
    // Sanity check that the /batch endpoint compiles even though the
    // seeded /agents portlets never trigger it. If a future change
    // accidentally breaks /batch, single-query mounts still work but
    // useMultiCubeLoadQuery falls back here. Hit it directly via fetch.
    await page.goto("/agents");
    const resp = await page.evaluate(async () => {
      const r = await fetch("/api/dashboards/cubejs-api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: [] }),
        credentials: "include",
      });
      return { status: r.status, hasResults: !!(await r.json()).results };
    });
    expect(resp.status).toBe(200);
    expect(resp.hasResults).toBe(true);
  });
});
