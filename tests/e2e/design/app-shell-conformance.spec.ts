/**
 * App-shell conformance guard (cinatra#1112).
 *
 * Locks in two shipped app-shell behaviours that previously had NO automated
 * coverage (each verified once by a manual live boot), driven on the real
 * AppShell that already wraps `/design-fixtures`:
 *
 *   1. Sidebar group LABEL-click expansion (from cinatra#819). Clicking a
 *      sidebar group's label — not just its chevron — toggles that group's
 *      sub-items, uniformly across every collapsible group INCLUDING Chat
 *      (whose label is a `<Link href="/chat">` wired to toggle in
 *      `handleChatLinkClick`, a hand-rolled parity with the whole-button
 *      `CollapsibleTrigger` of the generic NavGroup collapsibles). A
 *      regression back to chevron-only toggling for Chat would otherwise ship
 *      green.
 *
 *   2. Side-sheet top offset under the fixed app bar (from cinatra#833).
 *      Left/right sheets anchor at `top-16` (= the 64px sticky app-bar height)
 *      so the sheet header clears the bar. A regression to `top-0` would hide
 *      the drawer title behind the app bar again (the original defect).
 *
 * Assertion-based (no pixel baselines) — pixel-diff + axe stay owned by
 * design-fixtures.spec.ts. Runs in the `design-fixtures-chromium` project of
 * tests/e2e/config/design.config.ts, which boots the app with
 * CINATRA_E2E_SETUP_BYPASS=true so the full shell (sidebar + app bar) renders
 * on the otherwise-static `/design-fixtures` route.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures";

/**
 * Land on the fixture route and confirm the real app shell (not the
 * setup-redirect fallback) rendered. If this fails, the dev/standalone server
 * was booted without CINATRA_E2E_SETUP_BYPASS=true — the shell short-circuits
 * to "Redirecting to setup…" and neither the sidebar nor the app bar exist.
 */
async function gotoShell(page: Page): Promise<void> {
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByTestId("app-shell-topbar"),
    "the AppShell app bar must render — boot the server with CINATRA_E2E_SETUP_BYPASS=true",
  ).toBeVisible();
}

/**
 * Idempotent, hydration-robust expander. A click that lands before the sidebar
 * hydrates is silently swallowed (observed on the production standalone build),
 * so retry until the sub-items are visible — but only click while they are
 * still hidden, so a successful toggle is never accidentally reversed.
 */
async function expandViaLabel(label: Locator, subItems: Locator): Promise<void> {
  await expect(async () => {
    if (await subItems.isHidden()) await label.click();
    await expect(subItems).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
}

type CollapsibleGroup = {
  name: string;
  labelTestId: string;
  subItemsTestId: string;
  sampleSubItem: string;
  /**
   * Chat's label is a `<Link href="/chat">`; `handleChatLinkClick` only
   * suppresses navigation (and toggles in place) when the browser is already on
   * a /chat route (it reads `window.location.pathname`). Pin the URL to /chat
   * via history.replaceState — WITHOUT a real navigation, so Next's router
   * state (and the sidebar) stay put — so a label click exercises the in-place
   * toggle instead of navigating away. The generic NavGroup collapsibles toggle
   * a plain CollapsibleTrigger button and need no such guard.
   */
  suppressLinkNav?: boolean;
};

const COLLAPSIBLE_GROUPS: CollapsibleGroup[] = [
  {
    // Generic NavGroup collapsible (whole button is the CollapsibleTrigger).
    name: "Data",
    labelTestId: "sidebar-collapsible-label-data",
    subItemsTestId: "sidebar-collapsible-subitems-data",
    sampleSubItem: "All data",
  },
  {
    // Chat — label-click toggle is hand-rolled in handleChatLinkClick (#819).
    name: "Chat",
    labelTestId: "sidebar-chat-label",
    subItemsTestId: "sidebar-chat-subitems",
    sampleSubItem: "Threads",
    suppressLinkNav: true,
  },
];

test.describe("sidebar group label-click expansion (cinatra#819)", () => {
  for (const group of COLLAPSIBLE_GROUPS) {
    test(`${group.name}: clicking the group label toggles its sub-items`, async ({ page }) => {
      await gotoShell(page);

      if (group.suppressLinkNav) {
        // Keep the rendered /design-fixtures DOM; only the URL reads /chat so
        // the in-place toggle branch of handleChatLinkClick is taken.
        await page.evaluate(() => window.history.replaceState(null, "", "/chat"));
      }

      const label = page.getByTestId(group.labelTestId);
      await expect(label).toBeVisible();
      const subItems = page.getByTestId(group.subItemsTestId);

      // /design-fixtures is not any group's active route, so every collapsible
      // starts closed (its sub-menu is unmounted).
      await expect(subItems).toBeHidden();

      // Label click EXPANDS (the #819 behaviour, and the Chat regression guard:
      // with chevron-only toggling this click would never open the sub-items).
      await expandViaLabel(label, subItems);
      await expect(subItems.getByText(group.sampleSubItem, { exact: true })).toBeVisible();

      // Now hydrated — a second label click COLLAPSES, and a third re-EXPANDS,
      // proving the label toggles both directions.
      await label.click();
      await expect(subItems).toBeHidden();
      await label.click();
      await expect(subItems).toBeVisible();
    });
  }

  test("Chat: the chevron action still toggles independently of the label", async ({ page }) => {
    await gotoShell(page);
    const chevron = page.getByTestId("sidebar-chat-chevron");
    const subItems = page.getByTestId("sidebar-chat-subitems");
    await expect(chevron).toBeVisible();

    await expect(subItems).toBeHidden();
    // The chevron is a plain CollapsibleTrigger button (no navigation), so it
    // toggles with no URL guard — the label-click parity is additive, never a
    // replacement for the chevron.
    await expect(async () => {
      if (await subItems.isHidden()) await chevron.click();
      await expect(subItems).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 20_000 });
    await chevron.click();
    await expect(subItems).toBeHidden();
  });
});

test.describe("side-sheet top offset under the fixed app bar (cinatra#833)", () => {
  test("right-side sheet starts at the app-bar height and its title clears the bar", async ({
    page,
  }) => {
    await gotoShell(page);

    const topbar = page.getByTestId("app-shell-topbar");
    const trigger = page.getByTestId("sheet-fixture-open");
    const content = page.locator('[data-slot="sheet-content"][data-side="right"]');

    // Open the sheet (hydration-robust: retry the trigger until it mounts).
    await expect(async () => {
      if (!(await content.isVisible())) await trigger.click();
      await expect(content).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 20_000 });

    const title = content.locator('[data-slot="sheet-title"]');
    await expect(title).toBeVisible();
    await expect(title).toHaveText("Run inspector");

    // The sheet slides in along X (slide-in-from-right); wait until its right
    // edge reaches the viewport so geometry is measured on the settled panel.
    // The vertical offset (top-16) is not animated, but settling avoids any
    // mid-animation flake.
    await expect(async () => {
      const right = await content.evaluate((el) => el.getBoundingClientRect().right);
      expect(Math.abs(right - page.viewportSize()!.width)).toBeLessThan(1);
    }).toPass({ timeout: 5_000 });

    const bar = await topbar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    const box = await content.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right };
    });
    const titleBox = await title.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });

    // The sticky app bar is a 64px (h-16) band pinned to the viewport top
    // (no impersonation banner on /design-fixtures).
    expect(bar.top).toBeCloseTo(0, 0);
    expect(bar.height).toBeCloseTo(64, 0);

    // THE fix: the right sheet's box starts at the app-bar height (top-16 =
    // 64px) and never underneath the bar. A regression to top-0 makes box.top
    // 0 and fails both assertions.
    expect(box.top).toBeCloseTo(64, 0);
    expect(box.top).toBeGreaterThanOrEqual(bar.bottom - 1);

    // Right-anchored: the sheet hugs the right viewport edge.
    expect(box.right).toBeCloseTo(page.viewportSize()!.width, 0);

    // The SheetTitle sits fully below the app bar — not occluded (the original
    // #833 defect hid it behind the bar) — and has real height on screen.
    expect(titleBox.top).toBeGreaterThanOrEqual(bar.bottom - 1);
    expect(titleBox.bottom).toBeGreaterThan(titleBox.top);
  });
});
