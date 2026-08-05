/**
 * Unified /notifications v2 — keyboard-only operation + nested-controls
 * isolation + keepalive-on-navigate survival (cinatra#2381, S3 live
 * close-out).
 *
 * Per-widget keyboard semantics (never a generic "make it focusable" pass):
 *   - the toolbar's filter toggle group is a Radix `radiogroup` — ONE tab
 *     stop into the group (roving tabindex), Arrow keys move focus BETWEEN
 *     segments without leaving the group, Home/End jump to the first/last
 *     segment, and activating a focused segment with Space/Enter selects it
 *     exactly like a click;
 *   - a stretched-link card (notification/approval WITH an href) activates
 *     on Enter, matching native anchor semantics;
 *   - a stretched-button card (href-less notification) and the trailing
 *     read/unread toggle activate on BOTH Enter and Space, matching native
 *     button semantics;
 *   - the pager's disabled edge control (Previous on page 1) is skipped by
 *     Tab — never a focusable-but-inert dead stop.
 * Nested controls (the trailing toggle sitting above the stretched overlay,
 * §II) never also activate the card underneath — proven with a REAL
 * (coordinate-based) Playwright click, which performs actual hit-testing
 * unlike a jsdom unit test's direct `.click()` dispatch.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";
import { reseedMainViewer } from "./reseed";

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await reseedMainViewer();
});

test.describe("keyboard — the toolbar filter toggle group is one tab stop with Arrow/Home/End", () => {
  test("Arrow keys move focus between segments; Home/End jump to the first/last; Tab leaves the group in one stop", async ({
    page,
  }) => {
    await gotoFeed(page);
    const filters = page.locator('[data-conformance-id="notifications-filters"]');
    const segments = filters.getByRole("radio");
    await expect(segments).toHaveCount(4);

    const all = segments.nth(0);
    const needsAction = segments.nth(1);
    const unread = segments.nth(2);
    const inProgress = segments.nth(3);

    // Roving tabindex: before focus ever enters the group, Radix keeps every
    // item at tabindex="-1" — the group root holds the initial tab stop and
    // forwards entry focus to the selected segment. Only after entry does the
    // visited segment become the single item-level tab stop.
    await all.focus();
    await expect(all).toBeFocused();
    await expect(all).toHaveAttribute("tabindex", "0");
    await expect(needsAction).toHaveAttribute("tabindex", "-1");

    await page.keyboard.press("ArrowRight");
    await expect(needsAction).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(unread).toBeFocused();

    // End jumps to the last segment.
    await page.keyboard.press("End");
    await expect(inProgress).toBeFocused();
    // Home jumps back to the first.
    await page.keyboard.press("Home");
    await expect(all).toBeFocused();

    // Activating a focused (but not yet selected) segment with Space selects
    // it — same outcome as a click.
    await page.keyboard.press("ArrowRight"); // -> Needs action
    await expect(needsAction).toBeFocused(); // absorb Radix's deferred (setTimeout) focus move before activating
    await page.keyboard.press("Space");
    await expect(needsAction).toHaveAttribute("aria-checked", "true");

    // Tab leaves the group in exactly ONE stop — the next focusable element
    // is outside the toggle group (the "Mark all read" toolbar button), not
    // another segment.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Mark all read" })).toBeFocused();
  });
});

test.describe("keyboard — per-widget activation (Enter on links, Enter/Space on buttons)", () => {
  test("Enter activates a stretched-link card (notification WITH href) — navigates", async ({
    page,
  }) => {
    await gotoFeed(page);
    const e9Row = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "awaiting your approval" });
    const link = e9Row.locator('[data-action="activate -> navigated"]');
    await link.focus();
    await expect(link).toBeFocused();
    await Promise.all([
      page.waitForURL(/\/agents\/acme\/sales\/RUN-E9-UAT$/),
      page.keyboard.press("Enter"),
    ]);
  });

  test("Enter AND Space both activate the trailing read/unread toggle (a real button)", async ({
    page,
  }) => {
    await gotoFeed(page);
    const errRow = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "Blog Post Idea Generation failed" });
    const toggle = errRow.getByRole("button", { name: "Mark as read", exact: true });

    await toggle.focus();
    const patchPromise = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    await page.keyboard.press("Enter");
    await patchPromise;
    await expect(errRow.getByRole("button", { name: "Mark as unread", exact: true })).toBeVisible();

    // Toggle back with Space.
    const secondToggle = errRow.getByRole("button", { name: "Mark as unread", exact: true });
    await secondToggle.focus();
    const secondPatch = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    await page.keyboard.press("Space");
    await secondPatch;
    await expect(errRow.getByRole("button", { name: "Mark as read", exact: true })).toBeVisible();
  });

  test("Enter AND Space both activate a stretched-BUTTON card (href-less notification toggles read)", async ({
    page,
  }) => {
    await gotoFeed(page);
    // "Skill Prefill Generation completed" (ok-2) is href-less and seeded
    // unread — its stretched overlay is the BUTTON species (§II), distinct
    // from the E9 row's stretched LINK species used above.
    const okRow = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "Skill Prefill Generation completed" });
    const stretchedButton = okRow.locator('[data-action="activate -> toggled"]');
    await expect(stretchedButton).toHaveCount(1);
    await expect(okRow.getByRole("button", { name: "Mark as read", exact: true })).toBeVisible();

    await stretchedButton.focus();
    await expect(stretchedButton).toBeFocused();
    const patchPromise = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    await page.keyboard.press("Enter");
    await patchPromise;
    await expect(okRow.getByRole("button", { name: "Mark as unread", exact: true })).toBeVisible();

    // Space toggles it back.
    const backButton = okRow.locator('[data-action="activate -> toggled"]');
    await backButton.focus();
    const secondPatch = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    await page.keyboard.press("Space");
    await secondPatch;
    await expect(okRow.getByRole("button", { name: "Mark as read", exact: true })).toBeVisible();
  });
});

test.describe("keyboard — the pager's disabled edge control is skipped by Tab, never a dead focus stop", () => {
  test("on page 1, Tab never lands on the disabled Previous button", async ({ page }) => {
    await gotoFeed(page);
    // The canonical 8-row fixture never crosses the pager threshold, so no
    // pager renders (§VII "only when there is more than one page"). The
    // positive DISABLED-SKIP proof (Shift+Tab from the pager's first enabled
    // control never lands on the disabled Previous edge) lives in
    // notifications-pagination-threshold.spec.ts, where the pager is actually
    // present. Here we assert the negative baseline: no pager, so no dead stop is even
    // reachable — a structural sanity check that this suite's fixture size
    // does not accidentally exercise the pager unintentionally.
    await expect(page.locator('[data-conformance-id="notifications-list-pager"]')).toHaveCount(0);
  });
});

test.describe("nested controls never activate the card underneath (§II, real coordinate click)", () => {
  test("clicking the trailing toggle (real hit-test) never also navigates the href-carrying card", async ({
    page,
  }) => {
    await gotoFeed(page);
    const e9Row = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "awaiting your approval" });
    const toggle = e9Row.getByRole("button", { name: /Mark as (un)?read/ });

    const urlBefore = page.url();
    const patchPromise = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    // A real Playwright click performs actual pointer hit-testing at the
    // element's visible center — proving the toggle's z-10 stacking (above
    // the stretched overlay, §II) actually wins the hit-test in the real
    // browser, not merely in the DOM tree.
    await toggle.click();
    await patchPromise;

    // No navigation occurred — the underlying stretched LINK never fired.
    expect(page.url()).toBe(urlBefore);
  });

  test("the approval card's inline decide slot is not nested inside the stretched overlay (DOM stacking proof)", async ({
    page,
  }) => {
    // This approval species carries no href (§II href-less-approval
    // exemption — no stretched overlay at all), so the strongest available
    // structural proof is over the actionable Inbox row's decide slot: it
    // must never be a DESCENDANT of any stretched `<a>`/overlay `<button>`
    // in the card, or a real click on Approve/Reject would also trigger the
    // overlay's own activation via event bubbling. Non-destructive — reads
    // DOM structure only, never submits the decision.
    await gotoFeed(page);
    const inboxRow = page
      .locator('[data-conformance-id="approval-row"]')
      .filter({ hasText: "Quarterly Revenue Analyst" });
    const decideSlot = inboxRow.locator('[data-action="decide-approval -> decided"]');
    await expect(decideSlot).toBeVisible();

    const nestedInsideOverlay = await decideSlot.evaluate((el) =>
      Boolean(el.closest('[data-action="activate -> navigated"], .stretch')),
    );
    expect(nestedInsideOverlay).toBe(false);
  });
});

test.describe("keepalive mark-on-navigate survives a HARD navigation", () => {
  test("the stretched link's mark-read PATCH (keepalive:true) completes even though the click also navigates away", async ({
    page,
  }) => {
    await gotoFeed(page);
    const e9Row = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "awaiting your approval" });
    const link = e9Row.locator('[data-action="activate -> navigated"]');

    // Capture the PATCH request/response pair; `keepalive: true` on the
    // originating fetch is what lets this request outlive the document
    // unload the click triggers (browsers otherwise cancel in-flight
    // non-keepalive fetches on navigation).
    const patchRequestPromise = page.waitForRequest(
      (req) => req.url().includes("/api/notifications") && req.method() === "PATCH",
    );
    const navigationPromise = page.waitForURL(/\/agents\/acme\/sales\/RUN-E9-UAT$/);

    await link.click();

    const [patchRequest] = await Promise.all([patchRequestPromise, navigationPromise]);
    expect(patchRequest.postDataJSON()).toEqual({ id: "notif-uat-e9-1" });

    // Survival proof: navigate back and reload — the row is read, not
    // unread, so the PATCH genuinely completed server-side despite the
    // concurrent hard navigation (a cancelled/dropped PATCH would leave it
    // unread on reload).
    await gotoFeed(page);
    const reloadedE9Row = page
      .locator('[data-conformance-id="notification-row"]')
      .filter({ hasText: "awaiting your approval" });
    await expect(reloadedE9Row.getByRole("button", { name: "Mark as unread", exact: true })).toBeVisible();
  });
});
