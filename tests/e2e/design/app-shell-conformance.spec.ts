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

/**
 * Deterministically stop a sidebar `<Link>` anchor (identified by testid) from
 * performing its DEFAULT navigation, while leaving every React click handler on
 * it fully intact.
 *
 * A capture-phase document listener runs before Next's Link click handler and
 * calls `preventDefault()`. Because `preventDefault()` does NOT stop
 * propagation, the component's own onClick still fires (e.g.
 * `handleChatLinkClick`'s unconditional `setOpen((prev) => !prev)` toggle), and
 * Next's `<Link>` — which only navigates when the click was not
 * default-prevented — becomes a no-op. This isolates the #819 label-toggle
 * behaviour under test from the ORTHOGONAL /chat navigation, with no dependence
 * on `window.location` (which the App Router re-syncs to the canonical URL
 * between clicks). Document-level + testid-scoped via `closest()` so it survives
 * any React re-render/remount of the anchor and never touches other links.
 */
async function neutralizeLinkNav(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target;
        if (target instanceof Element && target.closest(`[data-testid="${CSS.escape(id)}"]`)) {
          e.preventDefault();
        }
      },
      { capture: true },
    );
  }, testId);
}

type CollapsibleGroup = {
  name: string;
  labelTestId: string;
  subItemsTestId: string;
  sampleSubItem: string;
  /**
   * Chat's label is a real `<Link href="/chat">` (the generic NavGroup
   * collapsibles toggle a plain CollapsibleTrigger button and never navigate, so
   * they need no guard). `handleChatLinkClick` toggles the collapsible
   * UNCONDITIONALLY, then only calls `e.preventDefault()` when the browser is
   * already on a /chat route (it reads `window.location.pathname`). This static
   * `/design-fixtures` harness cannot host the /chat route, and the App Router
   * owns `window.history`: a `replaceState("/chat")` to coax the in-place branch
   * is re-synced back to the canonical `/design-fixtures` URL between clicks, so
   * a later click navigates for real and unmounts the shell (the original
   * cinatra#1112 flake). When set, `neutralizeLinkNav` deterministically stops
   * the anchor's default navigation at the capture phase instead — the toggle
   * still fires, the navigation never does.
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
        // Chat's label is a real <Link href="/chat">. Neutralise its default
        // navigation deterministically (capture-phase preventDefault) so each
        // click only exercises the handleChatLinkClick toggle and never
        // navigates away from the harness — see the suppressLinkNav docs.
        await neutralizeLinkNav(page, group.labelTestId);
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
