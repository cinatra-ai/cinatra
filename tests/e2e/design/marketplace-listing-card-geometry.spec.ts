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
import {
  MARKETPLACE_GRID_COLUMN_STEPS,
  MARKETPLACE_GRID_GAP_PX,
  SPEC_DRAWN_CARD_WIDTH_PX,
  SPEC_DRAWN_COLUMNS,
  SPEC_DRAWN_CONTAINER_WIDTH_PX,
  marketplaceGridCardWidth,
  marketplaceGridColumns,
} from "../../../packages/extensions/src/screens/marketplace-grid-columns";

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

// ---------------------------------------------------------------------------
// 4. Footer-meta CLIP contract (cinatra#2409): the compat verdict and the
//    "Updated N ago" line must render INSIDE the card's clip box.
//
// The card root is `overflow-hidden`, and every child of the two-column meta
// row is `whitespace-nowrap` with a non-shrinkable left column and a
// `shrink-0` right one — so before the row had a fit strategy its intrinsic
// width simply ran past the card body and the right column's tails were
// sliced with no ellipsis and no other symptom ("Compatibility unknown" read
// as "Compatibilit"). Nothing measured it: both conformance harnesses left
// rating/installs/freshness null, so their meta rows were empty.
//
// Measured on the seeded production-density grid, which now renders the meta
// content the pinned drawing carries (rating, install count, freshness) and
// all THREE compat verdicts. The assertion is deliberately geometric, not
// class-based: no meta text may extend past the card body's content edge, at
// any sampled breakpoint. A revert of the wrap allowance fails it at every
// one.
// ---------------------------------------------------------------------------
for (const [bp, size] of Object.entries(VIEWPORTS)) {
  test.describe(`Seeded grid footer meta @ ${bp} (${size.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
    });

    for (const card of SEEDED_GRID_CARDS) {
      test(`${card.packageName}: compat verdict + freshness stay inside the card clip box`, async ({
        page,
      }, testInfo) => {
        const item = page
          .locator('[data-surface-id="extension-listing-grid"][data-variant="populated"]')
          .locator('[data-testid="marketplace-grid-item"]')
          .filter({ hasText: card.displayName });
        const compat = item.locator('[data-slot="extension-card-compat"]');
        await expect(compat).toBeVisible();

        const geometry = await item.evaluate((el) => {
          const meta = el.querySelector('[data-slot="extension-card-meta"]')!;
          // The meta row's own container is the card BODY; its content box
          // (padding excluded) is the edge the card's overflow clips at.
          const body = meta.parentElement!;
          const bodyRect = body.getBoundingClientRect();
          const bodyStyle = getComputedStyle(body);
          const contentRight = bodyRect.right - parseFloat(bodyStyle.paddingRight);
          const rights = [...meta.querySelectorAll("span")].map(
            (s) => s.getBoundingClientRect().right,
          );
          return {
            contentRight,
            maxRight: Math.max(...rights),
            metaOverflow: meta.scrollWidth - meta.clientWidth,
            compatText:
              meta.querySelector('[data-slot="extension-card-compat"]')?.textContent?.trim() ?? "",
          };
        });

        // 1px tolerance for subpixel rounding, the same allowance the
        // one-line row assertions above use.
        expect(geometry.maxRight).toBeLessThanOrEqual(geometry.contentRight + 1);
        expect(geometry.metaOverflow).toBeLessThanOrEqual(1);
        // The verdict is one of the three FULL labels — never a sliced tail.
        expect(["Compatible", "Incompatible", "Compatibility unknown"]).toContain(
          geometry.compatText,
        );
        testInfo.annotations.push({
          type: `footer-meta-compat@${bp}`,
          description: `${geometry.compatText} (overflow ${geometry.metaOverflow}px)`,
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Container-driven column sizing (cinatra#2495).
//
// The grid used to pick its column count from VIEWPORT breakpoints
// (`sm:2 lg:3 xl:4`) while its actual container is far narrower — the app-shell
// sidebar and the page gutters take a few hundred px off before the grid gets
// any width. The counts and their thresholds (640 / 1024 / 1280) are unchanged;
// what changed is that they are now measured against the grid's own container.
//
// Measured on the seeded production-density grid — the REAL
// ExtensionsMarketplaceClient inside the REAL app shell — at the four viewports
// cinatra#2488 round 2 measured the squeeze at (216px @800, 260px @1100,
// 236px @1280, 276px @1440, against the drawn 352px card).
//
// Each viewport asserts the FULL deterministic rule rather than a hard-coded
// pixel: columns = the step table applied to the measured container, card width
// = that container split into equal tracks minus the gaps (1px tolerance, the
// same allowance the row assertions above use). The concrete measured numbers
// are recorded as annotations so the run reports what it actually saw.
//
// Anti-false-green: each case first asserts the container-derived count DIFFERS
// from the viewport-derived one (the same step table applied to the viewport
// width — i.e. exactly the rule this replaces). Where those two coincide the
// case could not tell the rules apart, and the assertion would be theatre.
// ---------------------------------------------------------------------------

/** The four viewports cinatra#2488 round 2 measured the card squeeze at. */
const MEASURED_VIEWPORTS = [800, 1100, 1280, 1440] as const;

const GRID = '[data-surface-id="extension-listing-grid"][data-variant="populated"]';

/**
 * The grid's container inline size, the grid's own width, its RENDERED column
 * count (from the used `grid-template-columns` track list, not from a class
 * name), and every visible card's width.
 */
async function gridGeometry(page: Page) {
  return page.locator(GRID).evaluate((root) => {
    const grid = root.querySelector<HTMLElement>('[data-testid="marketplace-grid"]')!;
    // Resolved by ANCESTRY, not by document order: the container query only
    // applies if the container element genuinely CONTAINS the grid.
    const container = grid.closest<HTMLElement>('[data-testid="marketplace-grid-container"]')!;
    const tracks = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/);
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-testid="marketplace-grid-item"]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => Math.round(el.getBoundingClientRect().width * 100) / 100);
    return {
      // FRACTIONAL width, not `clientWidth` — `clientWidth` rounds, so at a
      // sub-pixel width near a step (639.5 / 1023.5 / 1279.5) it would disagree
      // with the value the CSS container query actually resolved against. The
      // container carries no padding or border by design, so its border box IS
      // the queried inline size.
      containerWidth: container.getBoundingClientRect().width,
      gridWidth: grid.getBoundingClientRect().width,
      columns: tracks.length,
      cardWidths: cards,
      containsGrid: container.contains(grid) && container !== grid,
    };
  });
}

/** Pin the grid's CONTAINER to an exact inline size, viewport untouched. */
async function setContainerWidth(gridRoot: Locator, px: number) {
  await gridRoot.evaluate((root, width) => {
    const grid = root.querySelector<HTMLElement>('[data-testid="marketplace-grid"]')!;
    const container = grid.closest<HTMLElement>('[data-testid="marketplace-grid-container"]')!;
    container.style.width = `${width}px`;
  }, px);
}

/**
 * Wait until the app shell's sidebar width transition (200ms) has finished, so
 * a geometry read is of a SETTLED layout rather than a frame mid-animation.
 * Stability-based, not a fixed sleep: two consecutive animation frames must
 * report the same container width.
 */
async function waitForSettledContainer(page: Page) {
  // `page.evaluate` (unlike `waitForFunction`) AWAITS a returned promise, so
  // the rAF loop has to live inside ONE evaluate call: a promise-returning
  // `waitForFunction` predicate resolves truthy on its first poll (a Promise
  // object is truthy) and would stop waiting immediately.
  const settled = await page.evaluate(async () => {
    const read = () => {
      const grid = document.querySelector('[data-testid="marketplace-grid"]');
      const container = grid?.closest('[data-testid="marketplace-grid-container"]');
      return container ? container.getBoundingClientRect().width : NaN;
    };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let previous = read();
    // 5s at 60fps, matching the poll budget the callers use elsewhere.
    for (let i = 0; i < 300; i++) {
      await frame();
      const current = read();
      if (Number.isFinite(current) && current === previous) return true;
      previous = current;
    }
    return false;
  });
  expect(settled, "container width never settled").toBe(true);
}

for (const width of MEASURED_VIEWPORTS) {
  test(`grid columns derive from the CONTAINER, not the viewport @ ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.locator(GRID).locator('[data-testid="marketplace-grid"]')).toBeVisible();

    const geometry = await gridGeometry(page);
    const expectedColumns = marketplaceGridColumns(geometry.containerWidth);
    const viewportColumns = marketplaceGridColumns(width);

    // The container is genuinely narrower than the viewport (the app shell is
    // really in frame — this is not a full-bleed fixture route).
    expect(geometry.containerWidth).toBeLessThan(width);
    // …and the two rules genuinely disagree here, so what follows discriminates.
    expect(expectedColumns).not.toBe(viewportColumns);

    // The container really is an ANCESTOR of the grid — otherwise its
    // container queries would resolve against something else entirely.
    expect(geometry.containsGrid).toBe(true);
    // The container wrapper introduces no layout of its own.
    expect(Math.abs(geometry.gridWidth - geometry.containerWidth)).toBeLessThanOrEqual(1);

    expect(geometry.columns).toBe(expectedColumns);

    const expectedCardWidth = marketplaceGridCardWidth(geometry.containerWidth);
    expect(geometry.cardWidths.length).toBeGreaterThan(0);
    for (const cardWidth of geometry.cardWidths) {
      expect(Math.abs(cardWidth - expectedCardWidth)).toBeLessThanOrEqual(1);
    }

    // What the REPLACED rule would have produced in this same container: the
    // viewport's column count, so the same width split more ways.
    const viewportRuleCardWidth =
      (geometry.containerWidth - (viewportColumns - 1) * MARKETPLACE_GRID_GAP_PX) / viewportColumns;

    testInfo.annotations.push({
      type: `container-sizing@${width}`,
      description:
        `container ${geometry.containerWidth}px → ${geometry.columns} columns × ` +
        `${expectedCardWidth.toFixed(2)}px ` +
        `(viewport rule: ${viewportColumns} columns × ${viewportRuleCardWidth.toFixed(2)}px; ` +
        `drawn card ${SPEC_DRAWN_CARD_WIDTH_PX}px)`,
    });
  });
}

// ---------------------------------------------------------------------------
// 5b. The causal proof, with the viewport HELD CONSTANT: collapsing the
//     app-shell sidebar widens the grid's container by (16rem − 3rem) and the
//     grid re-columns accordingly. Nothing about the viewport changed, so a
//     viewport-sized grid cannot move here — this is the assertion that pins
//     WHICH quantity the columns respond to.
// ---------------------------------------------------------------------------
test("collapsing the sidebar re-columns the grid at a FIXED viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator(GRID).locator('[data-testid="marketplace-grid"]')).toBeVisible();

  const expanded = await gridGeometry(page);
  expect(expanded.columns).toBe(marketplaceGridColumns(expanded.containerWidth));

  // The top-bar trigger specifically — the shell also renders a SidebarRail
  // button with the same accessible name, so an accname locator is ambiguous.
  await page.locator('[data-slot="sidebar-trigger"]').click();
  // The sidebar width animates over 200ms. Poll on the COLUMN COUNT (the claim)
  // rather than on the width, then let the transition finish so the final read
  // is a settled layout: a mid-animation width would report a track count the
  // container is no longer at.
  await expect
    .poll(async () => (await gridGeometry(page)).columns, { timeout: 5_000 })
    .toBeGreaterThan(expanded.columns);
  await waitForSettledContainer(page);

  const collapsed = await gridGeometry(page);
  expect(page.viewportSize()!.width).toBe(1280);
  expect(collapsed.containerWidth).toBeGreaterThan(expanded.containerWidth);
  expect(collapsed.columns).toBe(marketplaceGridColumns(collapsed.containerWidth));
  // The freed sidebar width must actually cross a step for this to prove
  // anything — if it ever stops crossing one, the case is no longer a proof.
  expect(collapsed.columns).toBeGreaterThan(expanded.columns);

  testInfo.annotations.push({
    type: "sidebar-toggle@1280",
    description:
      `expanded: container ${expanded.containerWidth}px → ${expanded.columns} columns; ` +
      `collapsed: container ${collapsed.containerWidth}px → ${collapsed.columns} columns ` +
      `(viewport 1280px throughout)`,
  });
});

// ---------------------------------------------------------------------------
// 5c. The pinned drawing's own arrangement, reproduced. Hand the grid the
//     container width the drawing is laid out at (specs/app-extensions.html §I:
//     a 1180px `.wrap` less 2 × 48px padding = 1084px, three 1fr tracks with a
//     14px gap = a 352px card) and the app must answer the DRAWN column count.
//     Driven by shrinking the container at a fixed viewport — the drawn width
//     is a CONTAINER width, and under the old rule the same container could
//     render anything from 1 to 4 columns depending on the window around it.
// ---------------------------------------------------------------------------
test("at the drawing's own container width the grid renders the drawn arrangement", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
  const grid = page.locator(GRID);
  await expect(grid.locator('[data-testid="marketplace-grid"]')).toBeVisible();

  await setContainerWidth(grid, SPEC_DRAWN_CONTAINER_WIDTH_PX);

  await expect
    .poll(async () => (await gridGeometry(page)).containerWidth, { timeout: 5_000 })
    .toBe(SPEC_DRAWN_CONTAINER_WIDTH_PX);

  const geometry = await gridGeometry(page);
  expect(geometry.columns).toBe(SPEC_DRAWN_COLUMNS);

  // The drawn card is 352px at the drawing's 14px gap; the app's `gap-4` is
  // 16px, so each of the three tracks is (16 − 14) × 2 / 3 = 1.33px narrower.
  // Anything beyond that is a real divergence from the drawing.
  const gapDelta =
    ((MARKETPLACE_GRID_GAP_PX - 14) * (SPEC_DRAWN_COLUMNS - 1)) / SPEC_DRAWN_COLUMNS;
  // Non-vacuous: a regression that hid every card would satisfy the loop below.
  expect(geometry.cardWidths.length).toBeGreaterThan(0);
  for (const cardWidth of geometry.cardWidths) {
    expect(Math.abs(cardWidth - (SPEC_DRAWN_CARD_WIDTH_PX - gapDelta))).toBeLessThanOrEqual(1);
  }

  await testInfo.attach("2495-drawn-container-width-grid", {
    body: await grid.screenshot(),
    contentType: "image/png",
  });
});

// ---------------------------------------------------------------------------
// 5d. The cinatra#2488 meta-row wrap allowance is still the safety net, at the
//     FOUR measured viewports (§4 above samples md/lg/xl). Re-columning changes
//     every card width, so the clip contract is re-proven at exactly the widths
//     the container rule now produces: no meta text past the card body's
//     content edge, and the compat verdict is one of the three FULL labels.
// ---------------------------------------------------------------------------
for (const width of MEASURED_VIEWPORTS) {
  test(`footer meta stays inside the clip box at the container-derived width @ ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.locator(GRID).locator('[data-testid="marketplace-grid"]')).toBeVisible();

    const perCard = await page.locator(GRID).evaluate((root) => {
      const items = [
        ...root.querySelectorAll<HTMLElement>('[data-testid="marketplace-grid-item"]'),
      ].filter((el) => el.offsetParent !== null);
      return items.map((item) => {
        const meta = item.querySelector('[data-slot="extension-card-meta"]')!;
        const body = meta.parentElement!;
        const bodyRect = body.getBoundingClientRect();
        const contentRight = bodyRect.right - parseFloat(getComputedStyle(body).paddingRight);
        const rights = [...meta.querySelectorAll("span")].map(
          (s) => s.getBoundingClientRect().right,
        );
        return {
          overshoot: Math.max(...rights) - contentRight,
          metaOverflow: meta.scrollWidth - meta.clientWidth,
          compatText:
            meta.querySelector('[data-slot="extension-card-compat"]')?.textContent?.trim() ?? "",
        };
      });
    });

    expect(perCard.length).toBe(SEEDED_GRID_CARDS.length);
    for (const card of perCard) {
      expect(card.overshoot).toBeLessThanOrEqual(1);
      expect(card.metaOverflow).toBeLessThanOrEqual(1);
      expect(["Compatible", "Incompatible", "Compatibility unknown"]).toContain(card.compatText);
    }

    testInfo.annotations.push({
      type: `footer-meta-overshoot@${width}`,
      description: `max ${Math.max(...perCard.map((c) => c.overshoot)).toFixed(2)}px over ${perCard.length} cards`,
    });
  });
}

// ---------------------------------------------------------------------------
// 5e. Step BOUNDARIES, in a real browser, at a fixed viewport (cinatra#2495).
//
// The container thresholds are inclusive minimums (`min-width: N` matches AT
// N). Only a browser can prove that the CSS agrees with the step table on the
// exact pixel — a helper-only test would just be the table asserting itself.
// Each pair is (N − 1, N): the low side must render the PREVIOUS count and the
// high side the next, which also renders the four-column state no viewport in
// this suite produces (the app shell never leaves a 1280px container).
// ---------------------------------------------------------------------------
test("container step thresholds are inclusive minimums, in the browser", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1400 });
  await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
  const grid = page.locator(GRID);
  await expect(grid.locator('[data-testid="marketplace-grid"]')).toBeVisible();

  const observed: string[] = [];
  for (const step of MARKETPLACE_GRID_COLUMN_STEPS) {
    for (const width of [step.minContainerWidthPx - 1, step.minContainerWidthPx]) {
      await setContainerWidth(grid, width);
      await expect
        .poll(async () => (await gridGeometry(page)).containerWidth, { timeout: 5_000 })
        .toBe(width);

      const geometry = await gridGeometry(page);
      expect(geometry.columns).toBe(marketplaceGridColumns(width));
      const expectedCardWidth = marketplaceGridCardWidth(width);
      expect(geometry.cardWidths.length).toBeGreaterThan(0);
      for (const cardWidth of geometry.cardWidths) {
        expect(Math.abs(cardWidth - expectedCardWidth)).toBeLessThanOrEqual(1);
      }
      observed.push(`${width}→${geometry.columns}×${expectedCardWidth.toFixed(2)}px`);
    }
  }

  // The top step really did render four columns somewhere above.
  expect(observed.some((o) => o.includes("→4×"))).toBe(true);
  testInfo.annotations.push({ type: "container-step-boundaries", description: observed.join(", ") });
});
