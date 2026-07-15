/**
 * Playwright UAT for the top-navbar notifications bell — badge + link, no flyout.
 *
 * The bell flyout was retired in the E8 cutover (cinatra#1558) per the ratified
 * notifications design spec §IV ("The bell — badge + link, no flyout"). The bell
 * is now a badge and a link and nothing more:
 *   1. The badge reflects the seeded unread terminal count, and is
 *      destructive-colored when any unread row has kind=error.
 *   2. Activating the bell NAVIGATES to `/notifications`; it opens no popover,
 *      dropdown, or inline list under it.
 *
 * Fixture state (from `seed.ts`):
 *   - 12 terminal rows (8 unread: 4 success + 3 error + 1 warning; 4 read).
 *   - 1 running info-kind row (auto-read at INSERT — does NOT contribute to the
 *     bell badge count).
 */
import { expect, test } from "@playwright/test";

// First-test cold-compile on a fresh worktree can easily blow past 60s
// when the dev server is reading .env.local + spinning Turbopack + the
// Postgres listener and SSE handshake. Give the spec breathing room.
test.describe.configure({ timeout: 120_000 });

test.describe("notifications bell (badge + link)", () => {
  test.beforeEach(async ({ page }) => {
    // Force the tab to report visible BEFORE any page script runs. The E6
    // store's backlog GET early-returns on `document.hidden` — a real-user perf
    // optimisation — but headless Chromium reports the tab hidden when not
    // focused, which silently suppresses the backlog fetch and leaves the badge
    // empty. SSE only pushes NEW INSERTs, never a backlog snapshot, so without
    // this shim every count assertion fails on an empty render.
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
    // Land on a non-bypass path. `/desk` (→ /personal) is the canonical
    // authenticated home; the app-shell + bell are mounted there.
    //
    // `waitUntil: "domcontentloaded"` rather than `"load"` — the SSE
    // EventSource keeps the document "loading" indefinitely on some browser
    // builds, which makes the default `"load"` strategy time out even when the
    // page is interactive.
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    // The bell is now a LINK labelled "Notifications" (+ the unread count).
    await expect(
      page.getByRole("link", { name: /^Notifications/ }),
    ).toBeVisible({ timeout: 60_000 });
    // Wait for React App Router client hydration to actually attach to the bell
    // before any subsequent assertion. The SSR markup appears quickly, but in
    // this dev environment hydration can take 20–40s (Turbopack Fast-Refresh
    // churn + transpilePackages recompiles). React attaches `__reactFiber$…`
    // keys to a DOM node only after `hydrateRoot` commits.
    await page.waitForFunction(
      () => {
        const bell = document.querySelector('a[aria-label^="Notifications"]');
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
    const bell = page.getByRole("link", { name: /^Notifications/ });
    // The bell renders a Badge child when there is anything needing the viewer.
    // The badge = unread notifications + actionable approvals (§IV). The seed
    // provisions 8 unread terminals (4 success + 3 error + 1 warning; the running
    // row is auto-read) and NO pending approvals for the viewer, so the badge is
    // 8.
    const badge = bell.locator(".absolute");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("8");
    // Destructive variant fires when ANY unread row has kind=error.
    await expect(badge).toHaveClass(/destructive/);
    // The count is also carried in the accessible name (§IV — "what needs the
    // viewer").
    await expect(bell).toHaveAttribute(
      "aria-label",
      "Notifications, 8 need your attention",
    );
  });

  test("activating the bell navigates to /notifications and opens no popover", async ({
    page,
  }) => {
    const bell = page.getByRole("link", { name: /^Notifications/ });
    // A plain link: clicking navigates. No popover opens under it (§IV).
    // Use `waitUntil: "commit"` so we don't hang on the SSE EventSource keeping
    // the document in "load" state.
    await bell.click();
    await page.waitForURL(/\/notifications$/, {
      timeout: 30_000,
      waitUntil: "commit",
    });
    // The unified /notifications v2 surface: the page header + the §III filter
    // CHIPS (buttons, aria-pressed — never tabs). "All" is the default chip.
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "All", exact: true }),
    ).toBeVisible();
    // The bell has NO attached panel — the retired flyout's Radix tablist is
    // gone from every surface.
    await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  });
});
