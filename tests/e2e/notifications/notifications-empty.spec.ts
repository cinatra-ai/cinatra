/**
 * Unified /notifications v2 — the universal empty state (cinatra#1561, E11),
 * spec §V ("the empty page says exactly 'No notifications' — never a per-type /
 * per-approval-type empty"). Runs as the `chromium-empty` project against a
 * distinct admin+org viewer with ZERO notifications and ZERO pending approvals
 * (auth.empty.setup.ts), so BOTH feed halves are live and genuinely empty — the
 * render is the single universal state, not a notifications-only degrade.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";

test.describe.configure({ timeout: 120_000 });

test.describe("§V — one universal empty state", () => {
  test("§V · an empty feed shows exactly ONE 'No notifications' state and no rows", async ({
    page,
  }) => {
    await gotoFeed(page);

    const empty = page.locator('[data-conformance-id="notifications-empty"]');
    await expect(empty).toHaveCount(1);
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No notifications");

    // No list, no rows, and NO per-type / per-source empty cards (§V).
    await expect(page.locator('[data-conformance-id="notifications-list"]')).toHaveCount(0);
    await expect(page.locator('[data-conformance-id="notification-row"]')).toHaveCount(0);
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(0);
    await expect(page.locator('[data-conformance-id="notifications-degraded"]')).toHaveCount(0);

    // The chip rail still renders (All is the default), it just filters nothing.
    await expect(
      page.locator('[data-conformance-id="notifications-filters"]').getByRole("button", {
        name: "All",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
