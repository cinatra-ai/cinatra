import { expect, test } from "@playwright/test";

import { DRUPAL_BASE, loginDrupal, readSeed } from "../helpers";

// The Drupal widget must NOT silently skip when its bundle fails to load — it
// renders a fallback button + a graceful error card, mirroring the WordPress
// plugin. Since the S5 unified-broker cutover (cinatra#2029 / #1991) the widget
// mounts UNCONDITIONALLY: the capability handshake moved CLIENT-SIDE into the
// /embed/assistant iframe, so an unreachable instance no longer leaves the
// shell-level fallback (that failure now surfaces inside the iframe). The only
// thing that leaves the shell-level fallback is the widget BUNDLE failing to
// load/execute. We force that by aborting the widget JS (isolated to this test
// via route interception, no shared-state mutation): the module-rendered fallback
// chrome must remain visible, and clicking it runs the fallback's reachability
// probe to the instance's public /embed/assistant page (the cutover probe target).
// Aborting that too drives the network-failure "Cannot reach" branch — NOT the
// "not loaded yet" (probe-ok) or "not configured" (no-URL) branches.

test.describe("Drupal assistant fallback (bundle cannot load → error, not silent skip)", () => {
  test.beforeEach(async ({ page }) => {
    await loginDrupal(page);
  });

  test("fallback button + graceful error render when the bundle cannot load", async ({ page }) => {
    const seed = readSeed();
    // Force the cannot-mount state: abort the widget bundle so its IIFE never runs
    // and never sets data-cinatra-mounted (leaving the fallback). Count aborts so
    // the assertions PROVE the abort fired — the fallback chrome is server-rendered
    // and visible BEFORE the bundle loads, so a missed glob would otherwise let
    // this test pass spuriously.
    // The bundle is a LOCAL Drupal library (`js/cinatra-widget.js`); global-setup
    // disables Drupal JS aggregation for the UAT (cinatra#2031) so the raw per-file
    // asset is served and this filename glob matches deterministically — with
    // aggregation ON, core folds it into `js_<hash>.js` and the abort never fires
    // (the CI-only widgetBundleAborts == 0 anomaly).
    let widgetBundleAborts = 0;
    await page.route(/cinatra-widget\.js(\?|$)/, (route) => {
      widgetBundleAborts += 1;
      return route.abort();
    });
    // The fallback's click-time reachability probe targets the instance's public
    // /embed/assistant page (the cutover repoint, replacing the deleted
    // /api/agents/{slug}/capabilities probe). Abort it to force "Cannot reach".
    let embedProbeAborts = 0;
    await page.route(/\/embed\/assistant(\?|$)/, (route) => {
      embedProbeAborts += 1;
      return route.abort();
    });
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);

    // The widget bundle must have been blocked — proves the abort drove the
    // cannot-mount state, not a no-op glob.
    await expect.poll(() => widgetBundleAborts).toBeGreaterThanOrEqual(1);

    // With the bundle blocked the widget never mounts, so the module-rendered
    // fallback chrome must remain visible (proves it no longer silently skips).
    const btn = page.locator("#cw-fallback-btn");
    await expect(btn).toBeVisible();

    // Clicking probes /embed/assistant (aborted) and must surface the
    // network-failure "Cannot reach" branch — NOT the "not loaded yet" (probe-ok)
    // or "not configured" (no-URL) branches.
    await btn.click();
    await expect.poll(() => embedProbeAborts).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#cw-fallback-error")).toBeVisible();
    await expect(page.locator("#cw-fe-msg")).toContainText(/cannot reach/i);
  });
});
