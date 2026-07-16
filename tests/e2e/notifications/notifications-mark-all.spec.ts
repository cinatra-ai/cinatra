/**
 * Unified /notifications v2 — mark-all-read boundary semantics (cinatra#1561,
 * E11). Mark-all is a WATERMARK, not a blanket `{ all: true }`: it PATCHes
 * `{ beforeId }` = the id of the NEWEST-loaded notification, so the server marks
 * read only the caller's unread rows THROUGH that boundary (a row created after
 * it — even concurrently — is never marked read). This proves, on the production
 * build: the watermark is anchored at the newest-loaded row, the mutation clears
 * the unread state in place, and it persists across a reload.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";
import { reseedMainViewer } from "./reseed";

// The newest seeded notification (the E9 row, T-1m) — the mark-all watermark.
const NEWEST_NOTIFICATION_ID = "notif-uat-e9-1";

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await reseedMainViewer();
});

test.describe("mark-all-read boundary semantics (watermark, not blanket)", () => {
  test("mark-all PATCHes { beforeId } = the newest-loaded notification, clears unread, and persists", async ({
    page,
  }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    const unreadChip = filters.getByRole("button", { name: /^Unread/ });
    await expect(unreadChip).toContainText("4");

    const markAll = page.getByRole("button", { name: "Mark all read" });
    await expect(markAll).toBeEnabled();

    // Capture the PATCH the click issues.
    const patchPromise = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    await markAll.click();
    const patch = await patchPromise;
    const body = patch.postDataJSON() as Record<string, unknown>;

    // Watermark, anchored at the NEWEST-loaded notification — never { all: true }.
    expect(body).toHaveProperty("beforeId", NEWEST_NOTIFICATION_ID);
    expect(body).not.toHaveProperty("all");

    // Cleared in place: nothing left to mark read → the control disables.
    await expect(markAll).toBeDisabled();
    await expect(unreadChip).not.toContainText("4");

    // Persisted server-side through the boundary — a fresh load stays read.
    await gotoFeed(page);
    await expect(page.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    await expect(
      page.locator('[data-conformance-id="notifications-filters"]').getByRole("button", {
        name: /^Unread/,
      }),
    ).not.toContainText("4");
  });
});
