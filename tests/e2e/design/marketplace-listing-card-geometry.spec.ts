/**
 * MarketplaceListingCard — one-line CTA + "More details" row geometry proof
 * (cinatra#2363, epic #2360).
 *
 * The current ratified card spec §I moved the install CTA and "More details" from a
 * stacked column onto one row (details to the RIGHT of the CTA). Contract
 * (epic #2360, decided architecture): a guaranteed single line everywhere is
 * impossible with `shrink-0 whitespace-nowrap` buttons and long pending
 * labels at the narrowest card width — so the pair renders on ONE line
 * whenever it fits, and gracefully `flex-wrap`s onto two lines otherwise.
 * This proves that contract at increasing breakpoints on the REAL six-state
 * conformance harness (/design-fixtures/conformance, cinatra#985/#986): the
 * CTA and details slot are both present and visible at every width, and at
 * the WIDEST viewport (xl) the two standard-label states (available,
 * installed) render strictly on one row — the row never regresses back to a
 * stacked column now that the wrapper is `flex-row`.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

import { HARNESS_PATH } from "./conformance/contract";
import { CONFORMANCE_CARD_FIXTURES } from "../../../src/app/design-fixtures/conformance/fixture-data";

/**
 * Card root + its CTA/details slots for one conformance card fixture.
 *
 * The CTA wrapper (`data-testid="extension-card-cta"`) is `display: contents`
 * by design (cinatra#985 — zero layout impact) — an element with no box of
 * its own, so `getBoundingClientRect()` on it is meaningless for geometry.
 * The `cta` locator here resolves to the actual rendered `<button>` inside
 * that wrapper (every six-state CTA control is Button-based).
 */
function cardSlots(page: Page, surfaceId: string) {
  const root = page.locator(`[data-surface-id="${surfaceId}"]`);
  const cta = root.locator('[data-testid="extension-card-cta"] button');
  const details = root.getByRole("link", { name: "More details" }).or(
    root.getByRole("button", { name: "More details" }),
  );
  return { root, cta, details };
}

async function box(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

/** Two boxes sit on the SAME visual row when their vertical ranges overlap. */
function sameRow(a: { top: number; bottom: number }, b: { top: number; bottom: number }): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

const VIEWPORTS = {
  md: { width: 900, height: 1000 },
  lg: { width: 1200, height: 1000 },
  xl: { width: 1440, height: 1000 },
} as const;

for (const [bp, size] of Object.entries(VIEWPORTS)) {
  test.describe(`MarketplaceListingCard CTA/details row @ ${bp} (${size.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
    });

    for (const fixture of CONFORMANCE_CARD_FIXTURES) {
      test(`${fixture.surfaceId}: CTA + "More details" both render, side by side or gracefully wrapped`, async ({
        page,
      }) => {
        const { cta, details } = cardSlots(page, fixture.surfaceId);
        await expect(cta).toBeVisible();
        await expect(details).toBeVisible();

        const ctaBox = await box(cta);
        const detailsBox = await box(details);

        if (sameRow(ctaBox, detailsBox)) {
          // On one line: details sits to the RIGHT of the CTA (never above/
          // before it — the spec's fixed left-to-right order).
          expect(detailsBox.left).toBeGreaterThanOrEqual(ctaBox.left);
        } else {
          // Wrapped (only expected on the tightest fixtures at the tightest
          // breakpoint — e.g. the "Installing…" pending label): the details
          // control still renders BELOW the CTA, never overlapping it.
          expect(detailsBox.top).toBeGreaterThanOrEqual(ctaBox.bottom - 1);
        }
      });
    }
  });
}

test.describe("MarketplaceListingCard CTA/details row — single line at the widest breakpoint (xl)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.xl);
    await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
  });

  // The two short-label states (Install now / Installed) are the standard
  // case the epic's geometry contract guarantees a single line for at lg/xl
  // — assert it explicitly rather than only "not overlapping".
  for (const surfaceId of ["extension-listing-card-available", "extension-listing-card-installed"] as const) {
    test(`${surfaceId}: CTA and "More details" render strictly on one row at xl`, async ({ page }) => {
      const { cta, details } = cardSlots(page, surfaceId);
      const ctaBox = await box(cta);
      const detailsBox = await box(details);
      expect(sameRow(ctaBox, detailsBox)).toBe(true);
      expect(detailsBox.left).toBeGreaterThan(ctaBox.left);
    });
  }
});
