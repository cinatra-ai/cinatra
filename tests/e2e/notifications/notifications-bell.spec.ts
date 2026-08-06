/**
 * Top-navbar notifications bell — conformance UAT (cinatra#1561, E11), spec §IV
 * ("The bell — badge + link, no flyout"). The flyout was retired in the E8
 * cutover (#1558); the bell is now a badge and a link and nothing more.
 *
 * The badge counts WHAT NEEDS THE VIEWER (§IV): unread notifications (the E6
 * store's derived count) PLUS the viewer's Inbox-actionable approval count
 * (server-resolved). With the seed (4 unread terminal notifications incl. the
 * E9 row + 1 actionable Inbox approval, and NO actionable approval among the
 * viewer's own requests) the badge is 4 + 1 = 5, rendered as the spec's ONE
 * badge treatment — the solid-red `attention` pill (§IV `.bell .badge`;
 * cinatra#2460). The seed still includes an unread error notification: the
 * former error-tinted variant branch is retired, so the treatment must NOT
 * change because of it.
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

  test("§IV · badge = unread notifications + actionable approvals, ONE solid-red treatment even with an unread error", async ({
    page,
  }) => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    const badge = bell.locator(".absolute");

    // 4 unread notifications + 1 Inbox-actionable approval = 5.
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("5");
    // The spec's single badge treatment (§IV `.bell .badge`: solid red,
    // always-white text). The seed contains an unread kind=error
    // notification; the retired error-tinted branch must NOT resurface as a
    // different treatment.
    await expect(badge).toHaveClass(/bg-destructive/);
    await expect(badge).toHaveClass(/text-attention-foreground/);
    // §IV ring: box-shadow 0 0 0 2px var(--paper) → ring-2 ring-background.
    await expect(badge).toHaveClass(/ring-background/);
    // The count is carried in the accessible name (§IV — "what needs the viewer").
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 5 need your attention");

    // COMPUTED colors, not class names (PR #2472 review): the digit is WHITE
    // and the fill is the spec red (#a6384f = rgb(166, 56, 79)) in BOTH
    // themes — the pill never flips with the theme. Theme forcing mirrors
    // design-fixtures.spec.ts (next-themes localStorage key + reload).
    for (const theme of ["cinatra", "dark"] as const) {
      await page.evaluate((t) => window.localStorage.setItem("theme", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      const themedBadge = page
        .getByRole("link", { name: /^Notifications/ })
        .locator(".absolute");
      await expect(themedBadge, `${theme}: badge visible`).toBeVisible();
      await expect(themedBadge, `${theme}: digit always white`).toHaveCSS(
        "color",
        "rgb(255, 255, 255)",
      );
      await expect(themedBadge, `${theme}: solid spec red fill`).toHaveCSS(
        "background-color",
        "rgb(166, 56, 79)",
      );
    }
  });

  test("§IV · activating the bell navigates to /notifications and opens NO popover", async ({
    page,
  }) => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    await bell.click();
    await page.waitForURL(/\/notifications$/, { timeout: 30_000, waitUntil: "commit" });

    // The unified feed: page header + the §III toolbar toggle group (never tabs).
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("radio", { name: "All", exact: true })).toBeVisible();
    // The retired flyout's Radix tablist is gone from every surface; the
    // toggle group is a Radix radiogroup, never a tablist.
    await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  });
});
