/**
 * Top-navbar notifications bell — conformance UAT (cinatra#1561, E11), spec §IV
 * ("The bell — badge + link, no flyout"). The flyout was retired in the E8
 * cutover (#1558); the bell is now a badge and a link and nothing more.
 *
 * The badge counts WHAT NEEDS THE VIEWER (§IV): unread notifications (the E6
 * store's derived count) PLUS the viewer's Inbox-actionable approval count
 * (server-resolved). With the seed (4 unread terminal notifications incl. the
 * E9 row + 1 actionable Inbox approval, and NO actionable approval among the
 * viewer's own requests) the badge is 4 + 1 = 5, destructive because an unread
 * error notification is present.
 */
import { expect, test } from "@playwright/test";

import { reseedMainViewer } from "./reseed";

test.describe.configure({ timeout: 120_000 });

test.describe("notifications bell (badge + link, spec §IV)", () => {
  test.beforeEach(async ({ page }) => {
    // Restore the canonical fixture set (4 unread + 1 actionable approval) so the
    // badge math is order-independent (mark-all / decide specs mutate state).
    await reseedMainViewer();
    // Force the tab visible BEFORE any page script runs: the E6 store's backlog
    // GET early-returns on `document.hidden` (a real-user perf optimisation),
    // but headless Chromium reports the tab hidden when unfocused, which would
    // suppress the backlog fetch and leave the badge empty (SSE only pushes NEW
    // inserts, never a backlog snapshot).
    await page.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    });
    // `/personal` is the canonical authenticated home where the app-shell + bell
    // mount. `domcontentloaded` (not "load") — the SSE EventSource can keep the
    // document "loading" indefinitely.
    await page.goto("/personal", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: /^Notifications/ })).toBeVisible({
      timeout: 60_000,
    });
    // Wait for client hydration to attach to the bell before asserting counts.
    await page.waitForFunction(
      () => {
        const bell = document.querySelector('a[aria-label^="Notifications"]');
        return !!bell && Object.keys(bell).some((k) => k.startsWith("__reactFiber$"));
      },
      undefined,
      { timeout: 60_000 },
    );
  });

  test("§IV · badge = unread notifications + actionable approvals, destructive when an unread error exists", async ({
    page,
  }) => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    const badge = bell.locator(".absolute");

    // 4 unread notifications + 1 Inbox-actionable approval = 5.
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("5");
    // Destructive variant because an unread notification is kind=error.
    await expect(badge).toHaveClass(/destructive/);
    // The count is carried in the accessible name (§IV — "what needs the viewer").
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 5 need your attention");
  });

  test("§IV · activating the bell navigates to /notifications and opens NO popover", async ({
    page,
  }) => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    await bell.click();
    await page.waitForURL(/\/notifications$/, { timeout: 30_000, waitUntil: "commit" });

    // The unified feed: page header + the §III filter CHIPS (buttons, never tabs).
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
    // The retired flyout's Radix tablist is gone from every surface.
    await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  });
});
