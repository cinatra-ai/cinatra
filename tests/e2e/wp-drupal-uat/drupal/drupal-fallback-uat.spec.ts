import { expect, test } from "@playwright/test";

import { DRUPAL_BASE, loginDrupal, readSeed } from "../helpers";

// The Drupal widget must NOT silently skip when it cannot connect to Cinatra —
// it renders a fallback button + a graceful error card, mirroring the WordPress
// plugin. The widget bundle now ships locally with the module, so the
// "cannot connect" signal is the widget's reachability probe to
// /api/agents/drupal-content-editor/capabilities. We force that state by
// aborting the capabilities request (isolated to this test via route
// interception, no shared-state mutation): the local bundle boots but never
// mounts, so the module-rendered fallback chrome must remain visible and
// surface an error on click (the click's own reachability check also aborts).

test.describe("Drupal assistant fallback (cannot-connect → error, not silent skip)", () => {
  test.beforeEach(async ({ page }) => {
    await loginDrupal(page);
  });

  test("fallback button + graceful error render when the bundle cannot load", async ({ page }) => {
    const seed = readSeed();
    // Force the cannot-connect state: abort the widget's reachability probe so
    // the locally-shipped bundle boots but never mounts (leaving the fallback).
    // Count interceptions so the assertions PROVE the abort actually fired — the
    // fallback chrome is server-rendered and visible BEFORE negotiation, so a
    // missed glob would otherwise let this test pass spuriously.
    let capabilitiesAborts = 0;
    await page.route("**/api/agents/drupal-content-editor/capabilities", (route) => {
      capabilitiesAborts += 1;
      return route.abort();
    });
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);

    // The widget must have attempted (and been denied) its boot-time reachability
    // probe — this proves the abort drove the cannot-connect state, not a no-op glob.
    await expect.poll(() => capabilitiesAborts).toBeGreaterThanOrEqual(1);

    // With the probe aborted the widget never mounts, so the module-rendered
    // fallback chrome must remain visible (proves it no longer silently skips).
    const btn = page.locator("#cw-fallback-btn");
    await expect(btn).toBeVisible();

    // Clicking re-probes /capabilities (also aborted) and must surface the
    // network-failure "Cannot reach" branch — NOT the "not loaded yet" (probe-ok)
    // or "not configured" (no-URL) branches.
    await btn.click();
    await expect.poll(() => capabilitiesAborts).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#cw-fallback-error")).toBeVisible();
    await expect(page.locator("#cw-fe-msg")).toContainText(/cannot reach/i);
  });
});
