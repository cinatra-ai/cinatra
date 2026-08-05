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

/** design specs/app-notifications.html §III — `.n-toggle-group`. */
const SPEC_TOGGLE_RADIUS_PX = "7px";
/**
 * …and the same rule's `height: 34px` (cinatra#2432). Under the spec's
 * `box-sizing: border-box` that is the OUTER, bordered box; each segment is
 * drawn at `height:100%`, i.e. 32px inside the 1px hairline.
 *
 * This surface's spec draws the SAME 34px as /connectors', which is why the
 * height could be resolved once, in the shared primitive, without moving
 * either consumer away from its own drawing.
 */
const SPEC_TOGGLE_HEIGHT_PX = 34;
const SPEC_TOGGLE_ITEM_HEIGHT_PX = 32;

test.describe("§III — toolbar filter geometry", () => {
  test("§III · the segmented filter renders the spec's 7px radius on all four corners", async ({
    page,
  }) => {
    // Deliberately NOT `gotoFeed` — this measures static geometry, which is
    // final at first paint. The shared helper additionally waits for the
    // toolbar to HYDRATE, a wait whose budget is the whole test timeout and
    // which buys this assertion nothing.
    await page.goto("/notifications", { waitUntil: "domcontentloaded" });

    const toggle = page.locator('[data-conformance-id="notifications-filters"]');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
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

  test("§III · the segmented filter renders the spec's 34px, on 32px segments", async ({
    page,
  }) => {
    await page.goto("/notifications", { waitUntil: "domcontentloaded" });

    const toggle = page.locator('[data-conformance-id="notifications-filters"]');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute("data-size", "sm");

    // The height fix lives in the shared primitive, so THIS surface is the
    // proof that it reached the second consumer too — independently of the
    // /connectors pin in
    // tests/e2e/design/conformance/primitive-spec-geometry.spec.ts.
    // A revert reads 30 here (28px segments + the 1px hairline top and bottom).
    expect(
      await toggle.evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(SPEC_TOGGLE_HEIGHT_PX);

    const items = toggle.locator('[data-slot="toggle-group-item"]');
    const count = await items.count();
    // All · Needs action · Unread · In progress — this consumer has FOUR
    // segments where /connectors has three, so it exercises the shared rule on
    // a different item count.
    expect(count).toBe(4);
    for (let i = 0; i < count; i += 1) {
      expect(
        await items.nth(i).evaluate((el) => el.getBoundingClientRect().height),
      ).toBe(SPEC_TOGGLE_ITEM_HEIGHT_PX);
    }
  });
});
