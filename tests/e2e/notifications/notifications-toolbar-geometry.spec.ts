/**
 * §III toolbar — the segmented filter's corner radius, MEASURED (cinatra#2407).
 *
 * The second consumer of the shared `ui/toggle-group` primitive. Its spec draws
 * the segmented group at a 7px radius, exactly as /connectors' does, and the
 * feed's source has always asked for it (`rounded-[7px]`) — but the primitive's
 * `data-[size=sm]:rounded-…` rule used to win regardless, so the browser
 * computed 6px on both surfaces while both sources read 7px.
 *
 * That is why this assertion is a RENDERED measurement and not a class check:
 * the class was already correct when the defect was live. The fix moved the
 * primitive's size-dependent radius into the consumer's own `tailwind-merge`
 * conflict group, so an override now actually reaches the browser — this pins
 * that it still does on THIS surface, independently of the /connectors pin in
 * tests/e2e/design/conformance/primitive-spec-geometry.spec.ts.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";

/** design specs/app-notifications.html §III — `.n-toggle-group`. */
const SPEC_TOGGLE_RADIUS_PX = "7px";

test.describe("§III — toolbar filter geometry", () => {
  test("§III · the segmented filter renders the spec's 7px radius on all four corners", async ({
    page,
  }) => {
    await gotoFeed(page);

    const toggle = page.locator('[data-conformance-id="notifications-filters"]');
    await expect(toggle).toBeVisible();
    // The size whose primitive rule used to clobber the consumer override.
    await expect(toggle).toHaveAttribute("data-size", "sm");

    // A revert reads 6px here (`min(var(--radius-md),10px)` in the app scope).
    for (const corner of [
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-right-radius",
      "border-bottom-left-radius",
    ]) {
      await expect(toggle).toHaveCSS(corner, SPEC_TOGGLE_RADIUS_PX);
    }
  });
});
