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
 *   3. Top-bar edge anchoring (from cinatra#1284, reverses #1091 / PR #1153).
 *      The top-bar control row spans the full available width (the SidebarInset
 *      area = viewport minus the persistent sidebar) with only the standard edge
 *      gutters (px-5 → sm:px-8): the LEFT element anchors flush to the far-left
 *      available edge + gutter and the RIGHT element flush to the far-right edge
 *      − gutter, independent of the `max-w-7xl` content cap. A regression back to
 *      the centred `mx-auto max-w-7xl` stage (the #1091 behaviour) pulls both
 *      elements IN toward the content column on any viewport wider than the cap —
 *      this guard asserts, at a wide 1920px viewport, that they sit at the edge
 *      gutters and NOT at the content-cap edges, so that regression fails red.
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

// The retired "Data" group used to fill the generic-NavGroup-collapsible slot
// here; #1431 / PR #1582 folded it into the consolidated /artifacts surface, so
// its sidebar entry and `sidebar-collapsible-label-data` testid no longer exist.
// Nothing shipped replaces it ON THIS ROUTE: /design-fixtures renders the shell
// UNAUTHENTICATED, and the only remaining generic collapsible — Analytics — is
// admin-tier (metric.read), so the root layout pushes it onto hiddenNavTitles
// for a null session (src/app/layout.tsx) and AppSidebar filters it out. Chat is
// therefore the only collapsible group the fixture renders, and its label-click
// toggle is the hand-rolled handleChatLinkClick parity (#819) under guard.
const COLLAPSIBLE_GROUPS: CollapsibleGroup[] = [
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

test.describe("top-bar edge anchoring (cinatra#1284, reverses #1091)", () => {
  // A viewport wide enough that the AVAILABLE area (viewport minus the ~256px
  // persistent sidebar) meaningfully exceeds the max-w-7xl cap (80rem = 1280px),
  // so the centred-stage regression is observable. At 1600px the available area
  // (~1344px) is only ~64px over the cap, so the edge-anchored and content-cap
  // positions nearly coincide; 1920px leaves ~1664px available (~384px over the
  // cap) so the two layouts are unambiguously distinguishable.
  const WIDE_WIDTH = 1920;
  // sm:px-8 = 2rem = 32px at this width (>= the sm breakpoint of 640px).
  const GUTTER = 32;
  const CONTENT_CAP = 1280; // max-w-7xl

  test("left/right elements anchor at the available-area edges, not the content cap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: WIDE_WIDTH, height: 900 });
    await gotoShell(page);

    const row = page.getByTestId("app-shell-topbar-row");
    const left = page.getByTestId("app-shell-topbar-left");
    const right = page.getByTestId("app-shell-topbar-right");
    await expect(row).toBeVisible();
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();

    const rect = (l: Locator) =>
      l.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });

    const rowBox = await rect(row);
    const leftBox = await rect(left);
    const rightBox = await rect(right);

    // The row is the available area: it starts at the SidebarInset's left edge
    // (the persistent sidebar's inner edge when shown; otherwise viewport x=0)
    // and must be WIDER than the content cap at this viewport — proving we are
    // testing above the cap where the regression is visible.
    expect(rowBox.width).toBeGreaterThan(CONTENT_CAP);

    // Where the OLD centred `mx-auto max-w-7xl` stage would have placed each
    // element: the cap is centred in the available row, so its inner edges pull
    // IN by (rowWidth − cap) / 2 on each side.
    const capInset = (rowBox.width - CONTENT_CAP) / 2;
    const contentCapLeft = rowBox.left + capInset;
    const contentCapRight = rowBox.right - capInset;

    // THE fix: the left element sits at the available-area left edge + gutter,
    // NOT at the centred content-cap left edge.
    expect(leftBox.left).toBeCloseTo(rowBox.left + GUTTER, 0);
    // …and demonstrably to the LEFT of where the content-cap stage would place
    // it (a regression to #1091 makes leftBox.left ≈ contentCapLeft and fails).
    expect(leftBox.left).toBeLessThan(contentCapLeft - GUTTER);

    // THE fix: the right element sits at the available-area right edge − gutter,
    // NOT at the centred content-cap right edge.
    expect(rightBox.right).toBeCloseTo(rowBox.right - GUTTER, 0);
    // …and demonstrably to the RIGHT of the content-cap stage's right edge.
    expect(rightBox.right).toBeGreaterThan(contentCapRight + GUTTER);

    // The header itself stays full-bleed (border edge to edge): the header spans
    // the whole available area, matching the row — only the inner anchoring
    // changed, per AC #2.
    const header = await rect(page.getByTestId("app-shell-topbar"));
    expect(header.left).toBeCloseTo(rowBox.left, 0);
    expect(header.right).toBeCloseTo(rowBox.right, 0);
  });
});
