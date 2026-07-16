/**
 * Shared helpers for the unified /notifications v2 conformance specs
 * (cinatra#1561, E11).
 */
import { expect, type Page } from "@playwright/test";

/**
 * Wait until React App Router client hydration has attached to `selector`.
 * The SSR markup appears immediately, but the chip/decide handlers only fire
 * once `hydrateRoot` commits (it stamps `__reactFiber$…` keys onto the node) —
 * clicking before then is a no-op. In this environment hydration can take
 * 20–40s (Turbopack churn on the dev path; fast on the prod-standalone CI path).
 */
export async function waitForHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    selector,
    { timeout: 60_000 },
  );
}

/**
 * Navigate to the server-rendered `/notifications` feed and wait until it is
 * interactive: the filter chip rail is present AND hydrated. `waitUntil:
 * "domcontentloaded"` (not "load") because the E6 store's SSE EventSource can
 * keep the document "loading" indefinitely on some browser builds.
 */
export async function gotoFeed(page: Page, query = ""): Promise<void> {
  await page.goto(`/notifications${query}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Notifications", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-conformance-id="notifications-filters"]')).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page, '[data-conformance-id="notifications-filters"] button');
}

/** The ordered species (`notification` | `approval`) of every row in the list,
 *  top to bottom — the basis for the §I interleave assertion. */
export async function rowKindsInOrder(page: Page): Promise<Array<"notification" | "approval">> {
  return page.$$eval(
    '[data-conformance-id="notifications-list"] > li[data-conformance-id]',
    (rows) =>
      rows.map((r) =>
        r.getAttribute("data-conformance-id") === "approval-row" ? "approval" : "notification",
      ),
  );
}
