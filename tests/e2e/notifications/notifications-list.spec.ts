/**
 * Unified /notifications v2 feed — conformance UAT (cinatra#1561, E11).
 *
 * Item-by-item Playwright-vs-spec proof of the single chronological list on the
 * PRODUCTION build, against the ratified notifications design spec (E0, #1550;
 * the pinned contract recorded on the PR). Spec-section anchors (§I…§VI) are
 * carried in each test name per the conformance convention. Retires the deleted
 * flyout tabs UAT; the feed here is the E7/E8 unified surface (#1557/#1558).
 *
 * Seed (auth.setup.ts → seed.ts): 6 notifications (4 unread terminals incl. the
 * E9 run-awaiting-human row, 1 in-progress, 1 read) interleaved with 2 pending
 * approvals (1 actionable Inbox + 1 non-actionable Your-requests).
 */
import { expect, test } from "@playwright/test";

import { gotoFeed, rowKindsInOrder } from "./spec-utils";
import { reseedMainViewer } from "./reseed";

const INBOX_APPROVAL = "Quarterly Revenue Analyst"; // actionable Inbox row
const MINE_APPROVAL = "Personal Inbox Triage Bot"; // non-actionable Your-requests row

test.describe.configure({ timeout: 120_000 });

// Restore the canonical fixture set before each test so a prior spec's mutation
// (the reject in the decide spec, mark-all in its spec) can never bleed in.
test.beforeEach(async () => {
  await reseedMainViewer();
});

test.describe("§I — one interleaved, newest-first list (no clusters)", () => {
  test("§I · notifications and pending approvals render in ONE list, interleaved by time", async ({
    page,
  }) => {
    await gotoFeed(page);

    // Exactly ONE list container — no per-species / per-cluster sub-lists.
    await expect(page.locator('[data-conformance-id="notifications-list"]')).toHaveCount(1);

    const list = page.locator('[data-conformance-id="notifications-list"]');
    // 6 notification rows + 2 approval rows, all in the one list.
    await expect(list.locator('[data-conformance-id="notification-row"]')).toHaveCount(6);
    await expect(list.locator('[data-conformance-id="approval-row"]')).toHaveCount(2);

    // Interleave (no "notifications then approvals" clustering): the first
    // approval row is FLANKED by notification rows (one before, at least one
    // after) in DOM order.
    const kinds = await rowKindsInOrder(page);
    const firstApprovalIdx = kinds.indexOf("approval");
    expect(firstApprovalIdx).toBeGreaterThan(0);
    expect(kinds[firstApprovalIdx - 1]).toBe("notification");
    expect(kinds.slice(firstApprovalIdx + 1)).toContain("notification");
  });
});

test.describe("§II — one row shell, two species; eligibility, not raw pendingness", () => {
  test("§II · an actionable Inbox approval shows 'Awaiting you' + an inline decide", async ({
    page,
  }) => {
    await gotoFeed(page);

    const inboxRow = page
      .locator('[data-conformance-id="approval-row"]')
      .filter({ hasText: INBOX_APPROVAL });
    await expect(inboxRow).toHaveCount(1);

    // Eligibility pill = actionable.
    await expect(inboxRow.getByText("Awaiting you")).toBeVisible();
    // The trailing decide slot carries the real inline Approve / Reject.
    await expect(inboxRow.locator('[data-action="decide-approval -> decided"]')).toBeVisible();
    await expect(inboxRow.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(inboxRow.getByRole("button", { name: "Reject" })).toBeVisible();
    await expect(inboxRow.getByText("no action for you")).toHaveCount(0);
  });

  test("§II · a non-actionable Your-requests approval shows 'Awaiting others' + NO decide", async ({
    page,
  }) => {
    await gotoFeed(page);

    const mineRow = page
      .locator('[data-conformance-id="approval-row"]')
      .filter({ hasText: MINE_APPROVAL });
    await expect(mineRow).toHaveCount(1);

    await expect(mineRow.getByText("Awaiting others")).toBeVisible();
    await expect(mineRow.getByText("no action for you")).toBeVisible();
    // A mine-direction row is never actionable on this surface — no inline decide.
    await expect(mineRow.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("§II · a notification row carries an unread read-dot; approvals never do", async ({
    page,
  }) => {
    await gotoFeed(page);

    // The unread error notification renders its read-dot.
    const errRow = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "Blog Post Idea Generation failed" });
    await expect(errRow.getByLabel("Unread")).toBeVisible();

    // Neither approval row renders a read-dot (read-state is notifications-only).
    await expect(
      page.locator('[data-conformance-id="approval-row"]').getByLabel("Unread"),
    ).toHaveCount(0);
  });
});

test.describe("§III — four filter chips filter the ONE list in place", () => {
  test("§III · All is the default chip and shows every row", async ({ page }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');

    const all = filters.getByRole("button", { name: "All", exact: true });
    await expect(all).toHaveAttribute("aria-pressed", "true");

    // The four chips are BUTTONS with aria-pressed — never a Radix tablist.
    await expect(filters.getByRole("button")).toHaveCount(4);
    await expect(page.locator('[role="tablist"]')).toHaveCount(0);

    await expect(page.locator('[data-conformance-id="notification-row"]')).toHaveCount(6);
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(2);
  });

  test("§III · Needs action = ONLY viewer-actionable approvals (eligibility, count 1)", async ({
    page,
  }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    const needs = filters.getByRole("button", { name: /^Needs action/ });

    await expect(needs).toContainText("1"); // count badge
    await needs.click();
    await expect(needs).toHaveAttribute("aria-pressed", "true");

    // Exactly the one actionable approval; the non-actionable mine row and every
    // notification (even the actionable E9 one) are filtered OUT.
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(1);
    await expect(page.locator('[data-conformance-id="approval-row"]')).toContainText(
      INBOX_APPROVAL,
    );
    await expect(page.locator('[data-conformance-id="notification-row"]')).toHaveCount(0);
  });

  test("§III · Unread = unread NOTIFICATIONS only (count 4, no approvals)", async ({ page }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    const unread = filters.getByRole("button", { name: /^Unread/ });

    await expect(unread).toContainText("4");
    await unread.click();

    await expect(page.locator('[data-conformance-id="notification-row"]')).toHaveCount(4);
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(0);
  });

  test("§III · In progress = the running background row (count 1)", async ({ page }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    const inProgress = filters.getByRole("button", { name: /^In progress/ });

    await expect(inProgress).toContainText("1");
    await inProgress.click();

    await expect(page.locator('[data-conformance-id="notification-row"]')).toHaveCount(1);
    await expect(page.locator('[data-conformance-id="notification-row"]')).toContainText(
      "in progress",
    );
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(0);
  });
});

test.describe("§V — the E9 run-awaiting-human row is a notification, not an approval", () => {
  test("§V · the E9 run-awaiting-human row renders as a notification with an inline open link", async ({
    page,
  }) => {
    await gotoFeed(page);

    const e9Row = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "awaiting your approval" });
    await expect(e9Row).toHaveCount(1);

    // Its title is an "open -> navigated" deep-link to the run's approval surface.
    const link = e9Row.locator('[data-action="open -> navigated"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /\/agents\/acme\/sales\/RUN-E9-UAT$/);

    // It counts under Unread (a notification), never Needs-action (approval-only).
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    await filters.getByRole("button", { name: /^Needs action/ }).click();
    await expect(e9Row).toHaveCount(0);
  });
});

test.describe("§VI — a degraded approval source shows ONE inline line + a recovering retry", () => {
  // Uses the prod-unreachable e2e degrade seam (page.tsx, gated on
  // CINATRA_E2E_SETUP_BYPASS + ?e2e=degrade-approvals) to force the approval
  // half to fail on the INITIAL render only; the retry re-resolves the real
  // sources and recovers — the full §VI degrade → retry → replace round-trip.
  test("§VI · a failed approval source degrades to one inline line; retry replaces it with the healthy page", async ({
    page,
  }) => {
    await gotoFeed(page, "?e2e=degrade-approvals");

    const degraded = page.locator('[data-conformance-id="notifications-degraded"]');
    await expect(degraded).toBeVisible();
    await expect(degraded).toContainText("some approvals are currently unavailable");

    // The partial page still renders the notifications; the approval half is absent.
    await expect(page.locator('[data-conformance-id="notification-row"]')).not.toHaveCount(0);
    await expect(page.locator('[data-conformance-id="approval-row"]')).toHaveCount(0);

    // Retry re-requests the SAME cursor with healthy sources → REPLACES the
    // partial tail: the degraded line disappears and the approvals appear.
    await degraded.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator('[data-conformance-id="notifications-degraded"]')).toHaveCount(0);
    await expect(
      page.locator('[data-conformance-id="approval-row"]').filter({ hasText: INBOX_APPROVAL }),
    ).toBeVisible();
  });
});
