/**
 * Unified /notifications v2 — isolated 26+-entry pager-threshold proof
 * (cinatra#2381, S3 live close-out). §VII requires the pager to render only
 * when there is more than one page, at exactly 25 rows/page, counted over the
 * rendered (post-collapse, active-filter) rows, with a known "X of N" total.
 * The existing conformance suite (notifications-list.spec.ts) seeds only 8
 * rows total — never crossing the 25-row page boundary — so this spec proves
 * the threshold itself on a dedicated, ISOLATED 30-row dataset: every other
 * `notif-uat-*` / `acr-uat-*` fixture row is cleared for the duration (so the
 * pager's total is exactly 30, not 30-plus-whatever-else), then restored via
 * `reseedMainViewer()` in `afterEach` so the canonical-fixture specs are
 * unaffected by this spec's run.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";
import { reseedMainViewer } from "./reseed";
import {
  cleanupApprovalFixtures,
  cleanupNotificationFixtures,
  clearPaginationThresholdFixtures,
  seedPaginationThresholdFixtures,
} from "./seed";
import { DATABASE_URL, SCHEMA, ensureOrganizationByDirectInsert } from "./setup-helpers";

const EMAIL = process.env.E2E_NOTIF_USER_EMAIL ?? "notif-uat@local.test";
const PAGINATION_ROW_COUNT = 30; // 25/page (§VII) → page 1 = 25, page 2 = 5.

test.describe.configure({ timeout: 120_000 });

test.describe("§VII — isolated 26+-entry dataset exercises the pager threshold", () => {
  test.beforeEach(async () => {
    const orgId = await ensureOrganizationByDirectInsert(EMAIL);
    // Isolate: clear the canonical 6+2 fixture so the pager's total below is
    // exactly the 30 rows this spec seeds, not 30 plus the canonical set.
    await cleanupNotificationFixtures({ email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA });
    await cleanupApprovalFixtures({ databaseUrl: DATABASE_URL, schema: SCHEMA, orgId });
    await seedPaginationThresholdFixtures(
      { email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA },
      PAGINATION_ROW_COUNT,
    );
  });

  test.afterEach(async () => {
    // Restore the canonical fixture set for every OTHER spec in this suite.
    await clearPaginationThresholdFixtures({ email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA });
    await reseedMainViewer();
  });

  test("§VII · the pager renders, reports the exact known total, and pages forward/back over the isolated set", async ({
    page,
  }) => {
    await gotoFeed(page);

    const list = page.locator('[data-conformance-id="notifications-list"]');
    await expect(list.locator('[data-conformance-id="notification-row"]')).toHaveCount(25);

    const pager = page.locator('[data-conformance-id="notifications-list-pager"]');
    await expect(pager).toBeVisible();
    await expect(pager).toContainText("Page 1 of 2");
    await expect(pager).toContainText(`${PAGINATION_ROW_COUNT} total`);

    // Page 1: Previous is disabled (§ keyboard/pager — no wraparound); Next enabled.
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await expect(pager.getByRole("button", { name: "Next page" })).toBeEnabled();
    // The current-page indicator is a non-interactive aria-current span, never a button.
    const current = pager.locator('[aria-current="page"]');
    await expect(current).toHaveText("1");
    await expect(current).not.toHaveJSProperty("tagName", "BUTTON");

    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(pager).toContainText("Page 2 of 2");
    await expect(list.locator('[data-conformance-id="notification-row"]')).toHaveCount(
      PAGINATION_ROW_COUNT - 25,
    );
    // Last page: Next disabled, Previous enabled — no wraparound past the end.
    await expect(pager.getByRole("button", { name: "Next page" })).toBeDisabled();
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeEnabled();

    await pager.getByRole("button", { name: "Previous page" }).click();
    await expect(pager).toContainText("Page 1 of 2");
    await expect(list.locator('[data-conformance-id="notification-row"]')).toHaveCount(25);
  });

  test("§VII · a single page of the isolated set renders no pager at all", async ({ page }) => {
    // Shrink the isolated set to under the 25-row threshold for this one
    // assertion (still isolated — the canonical fixture stays cleared).
    await clearPaginationThresholdFixtures({ email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA });
    await seedPaginationThresholdFixtures(
      { email: EMAIL, databaseUrl: DATABASE_URL, schema: SCHEMA },
      10,
    );
    await gotoFeed(page);
    await expect(
      page.locator('[data-conformance-id="notifications-list"] [data-conformance-id="notification-row"]'),
    ).toHaveCount(10);
    await expect(page.locator('[data-conformance-id="notifications-list-pager"]')).toHaveCount(0);
  });
});
