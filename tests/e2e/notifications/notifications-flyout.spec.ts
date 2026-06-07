/**
 * Playwright UAT for the top-navbar notifications flyout.
 *
 * Scenarios covered:
 *   1. Bell badge reflects the seeded unread terminal count, and is
 *      destructive-colored when any unread row has kind=error.
 *   2. Opening the bell shows the All / Unread / In progress tabs with
 *      per-tab counts and the right rows in each.
 *   3. The ScrollArea inside All overflows (scrollHeight > clientHeight)
 *      with 13 seeded rows.
 *   4. The In progress tab shows the seeded running row with a spinner.
 *   5. Mark-all-read clears the unread badge.
 *   6. The "Open notification archive" footer link routes to
 *      `/notifications`.
 *
 * Fixture state (from `seed.ts`):
 *   - 12 terminal rows (8 success / 3 error / 1 warning).
 *     - 8 unread (5 success unread + 3 error + 0 warning unread? actually
 *       8 unread: 4 success unread + 3 error + 1 warning, matching
 *       TERMINAL_FIXTURES `read: false` count).
 *     - 4 read.
 *   - 1 running info-kind row (auto-read at INSERT — does NOT contribute
 *     to the bell badge count).
 */
import { expect, test } from "@playwright/test";

// First-test cold-compile on a fresh worktree can easily blow past 60s
// when the dev server is reading .env.local + spinning Turbopack + the
// Postgres listener and SSE handshake. Give the spec breathing room.
test.describe.configure({ timeout: 120_000 });

test.describe("notifications flyout", () => {
  test.beforeEach(async ({ page }) => {
    // Force the tab to report visible BEFORE any page script runs. The bell's
    // `loadNotifications()` (notifications-flyout.tsx) early-returns on
    // `document.hidden` — a real-user perf optimisation — but headless
    // Chromium reports the tab hidden when not focused, which silently
    // suppresses the backlog fetch and leaves the badge empty. SSE only
    // pushes NEW INSERTs, never a backlog snapshot, so without this shim
    // every count assertion fails on an empty render.
    await page.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
    });
    // Land on a non-bypass path. `/desk` is the canonical authenticated
    // home; the app-shell + flyout are mounted there.
    //
    // `waitUntil: "domcontentloaded"` rather than `"load"` — the SSE
    // EventSource keeps the document "loading" indefinitely on some
    // browser builds, which makes the default `"load"` strategy time
    // out even when the page is interactive.
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    // Wait for the header to render. The flyout's bell button is
    // labelled "Open notifications".
    await expect(
      page.getByRole("button", { name: "Open notifications" }),
    ).toBeVisible({ timeout: 60_000 });
    // Wait for React App Router client hydration to actually attach to the
    // bell button before any subsequent assertion. The bell SSR markup
    // appears quickly, but in this dev environment hydration can take 20–40s
    // because Turbopack fires 3-4 `[Fast Refresh] rebuilding` cycles during
    // the initial page load (transpilePackages workspace recompiles + dev
    // overlay churn). Without this wait, every interactive assertion below
    // (`expect(badge).toBeVisible`, `bell.click()` to open the popover) races
    // hydration and times out at the default 10s expect timeout.
    //
    // React attaches `__reactFiber$…` keys to a DOM node only after
    // `hydrateRoot` commits — checking for one is the reliable signal that
    // the notifications subtree is interactive. The `next.config.ts` fixes
    // for `allowedDevOrigins` (HMR connectivity) + `experimental.reactDebugChannel`
    // (decouple hydration from the dev React-debug-channel close chunk) make
    // hydration possible at all; this wait covers the residual dev-mode
    // compile latency.
    await page.waitForFunction(
      () => {
        const bell = document.querySelector(
          'button[aria-label="Open notifications"]',
        );
        return (
          !!bell &&
          Object.keys(bell).some((k) => k.startsWith("__reactFiber$"))
        );
      },
      undefined,
      { timeout: 60_000 },
    );
  });

  test("badge shows unread terminal count and destructive variant when errors are unread", async ({
    page,
  }) => {
    const bell = page.getByRole("button", { name: "Open notifications" });
    // Bell renders a Badge child when there are unreads. The
    // contract: running rows are auto-read, so the badge counts only
    // terminals — 8 in the seed (4 success + 3 error + 1 warning).
    const badge = bell.locator(".absolute");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("8");
    // Destructive variant fires when ANY unread row has kind=error.
    await expect(badge).toHaveClass(/destructive/);
  });

  test("opening the flyout shows three tabs with correct counts", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open notifications" }).click();
    // The popover renders three tab triggers labelled All / Unread / In progress.
    const allTab = page.getByRole("tab", { name: /^All/ });
    const unreadTab = page.getByRole("tab", { name: /^Unread/ });
    const inProgressTab = page.getByRole("tab", { name: /^In progress/ });
    await expect(allTab).toBeVisible();
    await expect(unreadTab).toBeVisible();
    await expect(inProgressTab).toBeVisible();

    // All count: 13 collapsed rows (12 terminals + 1 running, none share sourceJobId).
    await expect(allTab).toContainText("13");
    // Unread count: 8 unread terminals (running is auto-read).
    await expect(unreadTab).toContainText("8");
    // In progress count: 1 running row.
    await expect(inProgressTab).toContainText("1");
  });

  test("All tab list is scrollable when seeded with 13 rows", async ({ page }) => {
    await page.getByRole("button", { name: "Open notifications" }).click();
    // Wait for the running notification (newest, always rendered first) so
    // we know the list has populated before asking the viewport for its
    // scrollHeight. Other seeded titles aren't guaranteed to be in the
    // 10-row All-tab slice because the seed batches terminals at the same
    // `createdAt`.
    await expect(
      page
        .getByText("Blog Post Draft Generation in progress")
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    // ScrollArea uses the Radix data-slot attribute.
    const viewport = page.locator(
      '[data-slot="scroll-area-viewport"]:visible',
    );
    await expect(viewport.first()).toBeVisible();
    // Scrollable iff content overflows the fixed viewport height.
    const overflow = await viewport.first().evaluate((el) => {
      return el.scrollHeight - el.clientHeight;
    });
    expect(overflow).toBeGreaterThan(0);
  });

  test("In progress tab renders the running row with a spinner", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open notifications" }).click();
    await page.getByRole("tab", { name: /^In progress/ }).click();
    // The running row's title from the seed.
    await expect(
      page.getByText("Blog Post Draft Generation in progress"),
    ).toBeVisible();
    // The Spinner renders a `role="status"` with `aria-label="Loading"`
    // (see src/components/ui/spinner.tsx).
    await expect(
      page.getByRole("status", { name: "Loading" }),
    ).toBeVisible();
  });

  test("Mark-all-read clears the badge", async ({ page }) => {
    const bell = page.getByRole("button", { name: "Open notifications" });
    await bell.click();
    await page
      .getByRole("button", { name: "Mark all as read" })
      .first()
      .click();
    // Close the popover to re-evaluate the bell badge.
    await page.keyboard.press("Escape");
    // After mark-all-read, no unread rows remain → badge disappears.
    // Use a longer-than-default timeout because the PATCH RTT + state
    // update isn't instantaneous.
    const badge = bell.locator(".absolute");
    await expect(badge).toHaveCount(0, { timeout: 5_000 });
  });

  test("footer link routes to /notifications archive", async ({ page }) => {
    await page.getByRole("button", { name: "Open notifications" }).click();
    // 13 rows > 10 → label is "View all notifications".
    const link = page.getByRole("link", {
      name: /View all notifications|Open notification archive/,
    });
    await expect(link).toBeVisible({ timeout: 15_000 });
    // Wait for URL change with `waitUntil: "commit"` so we don't hang on
    // the SSE EventSource keeping the document in "load" state.
    await link.click();
    await page.waitForURL(/\/notifications$/, {
      timeout: 30_000,
      waitUntil: "commit",
    });
    // Archive page header.
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    // Archive tabs (same shape as the flyout).
    await expect(page.getByRole("tab", { name: /^All/ })).toBeVisible();
  });
});
