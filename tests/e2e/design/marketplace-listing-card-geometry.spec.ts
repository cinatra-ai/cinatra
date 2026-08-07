/**
 * MarketplaceListingCard — one-line CTA + "More details" row geometry proof
 * (cinatra#2363, epic #2360).
 *
 * The current ratified card spec §I moved the install CTA and "More details"
 * from a stacked column onto one row (details to the RIGHT of the CTA).
 * Contract (epic #2360, decided architecture): a guaranteed single line
 * everywhere is impossible with `shrink-0 whitespace-nowrap` buttons and long
 * pending labels at the narrowest card width — so the pair renders on ONE
 * line whenever it fits, and gracefully `flex-wrap`s onto two lines
 * otherwise. Proven here on TWO real compositions:
 *
 *   1. The six-state conformance harness (/design-fixtures/conformance,
 *      cinatra#985): every at-rest CTA label is short, and the sampled
 *      viewports sit INSIDE the Tailwind bands (mid-band slack over the
 *      band-minimum card widths), so the one-line arrangement is
 *      deterministic — asserted STRICTLY (same row, details right of the
 *      CTA, no overlap) for all six states at md, lg AND xl. A revert to the
 *      stacked column fails every one of these, at every breakpoint.
 *   2. The seeded production-density grid (cinatra#986 — the REAL
 *      ExtensionsMarketplaceClient grid), where each card renders a
 *      DIFFERENT six-state CTA identity at rest (cinatra#2363 item 2),
 *      including the long "Installing…" pending label the wrap allowance
 *      exists for.
 *
 * The "Installing…" pending presentation is ALSO exercised live (not only at
 * rest): the harness's installing fixture is clicked into its real pending
 * state (MarketplaceInstallSubmit, 8s fixture latency) and the rendered
 * label, geometry contract and a screenshot are captured mid-flight.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

import { HARNESS_PATH, SEEDED_HARNESS_PATH } from "./conformance/contract";
import { CONFORMANCE_CARD_FIXTURES } from "../../../src/app/design-fixtures/conformance/fixture-data";
import { SEEDED_GRID_CARDS } from "../../../src/app/design-fixtures/conformance/seed-data";

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

/**
 * The card's own BOX (width × height) — the quantity the §I.1 block-size
 * contract is about. Deliberately position-free: clicking a control inside a
 * long harness page scrolls it, so viewport-absolute top/left would report a
 * scroll as a geometry change.
 */
async function size(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
  });
}

/** Two boxes sit on the SAME visual row when their vertical ranges overlap. */
function sameRow(a: { top: number; bottom: number }, b: { top: number; bottom: number }): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * The STRICT one-line contract: same visual row, details strictly to the
 * right of the CTA's right edge (1px tolerance for subpixel rounding) — the
 * form that excludes overlap and equal left edges, per the review of this
 * suite's first iteration.
 */
function expectOneLineRow(ctaBox: Box, detailsBox: Box) {
  expect(sameRow(ctaBox, detailsBox)).toBe(true);
  expect(detailsBox.left).toBeGreaterThanOrEqual(ctaBox.right - 1);
}

/**
 * The graceful-wrap contract for the one composition where the pair may
 * legitimately not fit (the long pending label at the tightest density):
 * never overlapping, order preserved — details on the same row to the right,
 * or wrapped strictly BELOW. Returns which branch held so callers can record
 * it instead of hiding it inside a disjunction.
 */
function expectRowOrWrappedBelow(ctaBox: Box, detailsBox: Box): "one-line" | "wrapped" {
  if (sameRow(ctaBox, detailsBox)) {
    expect(detailsBox.left).toBeGreaterThanOrEqual(ctaBox.right - 1);
    return "one-line";
  }
  expect(detailsBox.top).toBeGreaterThanOrEqual(ctaBox.bottom - 1);
  return "wrapped";
}

const VIEWPORTS = {
  md: { width: 900, height: 1000 },
  lg: { width: 1200, height: 1000 },
  xl: { width: 1440, height: 1000 },
} as const;

// ---------------------------------------------------------------------------
// 1. Six-state harness — STRICT one-line at every sampled breakpoint.
//
// Every fixture's at-rest label is short ("Install now" / "Installed" /
// "Update now" / "Restore" — the installing fixture rests at "Install now",
// its pending label is exercised below), and the harness grid's md:2/lg:3/
// xl:4 columns at these viewports leave mid-band slack over the band-minimum
// card widths. The layout is therefore deterministic: the pair MUST sit on
// one row, details strictly right of the CTA. #2363's AC names lg and xl;
// md is asserted too because the evidence renders one-line there as well —
// a wrap at md would be a real presentation change, and this suite's first
// iteration was rightly faulted for a disjunction 18 of 20 tests could
// never fail.
// ---------------------------------------------------------------------------
for (const [bp, size] of Object.entries(VIEWPORTS)) {
  test.describe(`MarketplaceListingCard CTA/details row @ ${bp} (${size.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
    });

    for (const fixture of CONFORMANCE_CARD_FIXTURES) {
      test(`${fixture.surfaceId}: CTA + "More details" render strictly on one row, details to the right`, async ({
        page,
      }) => {
        const { cta, details } = cardSlots(page, fixture.surfaceId);
        await expect(cta).toBeVisible();
        await expect(details).toBeVisible();
        expectOneLineRow(await box(cta), await box(details));
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 2. The "Installing…" pending presentation, exercised for real (cinatra#2363
//    — the label the wrap contract is written around, previously measured by
//    nothing and shown in no screenshot).
// ---------------------------------------------------------------------------
for (const bp of ["md", "xl"] as const) {
  test(`installing pending state @ ${bp}: clicked into "Installing…", geometry contract holds, screenshot captured`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(VIEWPORTS[bp]);
    await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });

    // This fixture is an ARTIFACT — an install-access-target kind — so since
    // cinatra#2373 its Install now swaps the card body to the in-card install
    // panel instead of submitting. The pending presentation therefore belongs
    // to the PANEL's submit, and the geometry that matters at that moment is
    // that the card's own box does not move while the install is in flight.
    const { root, cta } = cardSlots(page, "extension-listing-card-installing");
    await expect(cta).toHaveText("Install now");
    const idleBox = await size(root.locator('[data-testid="extension-listing-card"]'));
    await cta.click();

    const face = root.locator('[data-testid="extension-install-panel"]');
    await expect(face).toBeVisible();
    // Opening the panel must not change the card's box (spec §I.1 block-size).
    expect(await size(face)).toEqual(idleBox);

    const submit = root.locator('[data-testid="extension-install-panel-submit"]');
    await expect(submit).toHaveText("Install now");
    await submit.click();

    // The REAL pending presentation (useFormStatus, 8s fixture latency — no
    // race): label swap + busy marker, on the panel's own submit.
    await expect(submit).toHaveText("Installing…");
    await expect(submit).toHaveAttribute("data-pending", "");
    await expect(submit).toBeDisabled();
    // A failure or a busy state never redraws or grows the panel (spec §I.1).
    expect(await size(face)).toEqual(idleBox);

    await testInfo.attach(`installing-pending-card-${bp}`, {
      body: await root.screenshot(),
      contentType: "image/png",
    });
  });
}

// ---------------------------------------------------------------------------
// 2b. The open/close geometry invariant in its WORST case: a single visible
//     card in its own `auto-rows-fr` row. With no taller peer to hold the
//     track up, a face that merely stretches (`h-full`) would let the shorter
//     install body SHRINK the row on open and grow it back on close — the
//     regression the shared spec block-size floor exists to prevent
//     (cinatra#2373).
// ---------------------------------------------------------------------------
for (const bp of ["md", "lg", "xl"] as const) {
  test(`in-card install panel @ ${bp}: a SOLE card's track is unchanged across open/close`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS[bp]);
    await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });

    // The dedicated install-panel mount renders exactly one card.
    const root = page.locator('[data-surface-id="extension-install-panel"]');
    const idle = root.locator('[data-testid="extension-listing-card"]');
    await expect(idle).toBeVisible();
    const idleBox = await size(idle);

    await root.locator('[data-testid="extension-install-panel-open"]').click();
    const face = root.locator('[data-testid="extension-install-panel"]');
    await expect(face).toBeVisible();
    expect(await size(face)).toEqual(idleBox);

    await root.locator('[data-testid="extension-install-panel-cancel"]').click();
    await expect(idle).toBeVisible();
    expect(await size(idle)).toEqual(idleBox);
  });
}

// ---------------------------------------------------------------------------
// 3. Seeded production-density grid (cinatra#986 harness, cinatra#2363 item
//    2): the REAL ExtensionsMarketplaceClient grid, one card per six-state
//    CTA identity AT REST (seed-data.ts assignment) — every CTA label
//    asserted, geometry proven at the real grid density. Short labels assert
//    the strict one-line row; the at-rest "Installing…" card asserts the
//    no-overlap contract with its arrangement recorded (it is the one label
//    the wrap allowance legitimately covers at the tightest density).
// ---------------------------------------------------------------------------
for (const [bp, size] of Object.entries(VIEWPORTS)) {
  test.describe(`Seeded grid CTA/details row @ ${bp} (${size.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
    });

    for (const card of SEEDED_GRID_CARDS) {
      test(`${card.packageName} (${card.ctaState}): CTA label + row geometry at grid density`, async ({
        page,
      }, testInfo) => {
        const item = page
          .locator('[data-surface-id="extension-listing-grid"][data-variant="populated"]')
          .locator('[data-testid="marketplace-grid-item"]')
          .filter({ hasText: card.displayName });
        await expect(
          item.locator('[data-testid="extension-card-cta"]'),
        ).toHaveAttribute("data-cta-state", card.ctaState);

        const cta = item.locator('[data-testid="extension-card-cta"] button');
        const details = item.getByRole("button", { name: "More details" });
        await expect(cta).toHaveText(card.ctaLabel);
        await expect(details).toBeVisible();

        const ctaBox = await box(cta);
        const detailsBox = await box(details);
        if (card.ctaState === "installing") {
          const arrangement = expectRowOrWrappedBelow(ctaBox, detailsBox);
          testInfo.annotations.push({
            type: `seeded-pending-row-arrangement@${bp}`,
            description: arrangement,
          });
          await testInfo.attach(`seeded-installing-at-rest-${bp}`, {
            body: await item.screenshot(),
            contentType: "image/png",
          });
        } else {
          expectOneLineRow(ctaBox, detailsBox);
        }
      });
    }
  });
}
