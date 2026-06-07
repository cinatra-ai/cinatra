import { expect, test } from "@playwright/test";

import { DRUPAL_BASE, loginDrupal, readSeed } from "../helpers";

// The Drupal widget must NOT silently skip when it cannot connect to Cinatra —
// it renders a fallback button + a graceful error card, mirroring the WordPress
// plugin. We force the "cannot connect" state by
// aborting the bundle request (isolated to this test via route interception, no
// shared-state mutation) so the real widget never mounts; the module-rendered
// fallback chrome must remain visible and surface an error on click.

test.describe("Drupal assistant fallback (cannot-connect → error, not silent skip)", () => {
  test.beforeEach(async ({ page }) => {
    await loginDrupal(page);
  });

  test("fallback button + graceful error render when the bundle cannot load", async ({ page }) => {
    const seed = readSeed();
    // Force the cannot-connect state: the real bundle never loads/mounts.
    await page.route("**/api/drupal/bundle.js", (route) => route.abort());
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);

    // The module must render the fallback chrome (proves it no longer skips).
    const btn = page.locator("#cw-fallback-btn");
    await expect(btn).toBeVisible();

    // Clicking surfaces a graceful admin-facing error (the HEAD-check also aborts).
    await btn.click();
    await expect(page.locator("#cw-fallback-error")).toBeVisible();
    await expect(page.locator("#cw-fe-msg")).toContainText(
      /cannot reach|HTTP|not loaded|not configured/i,
    );
  });
});
