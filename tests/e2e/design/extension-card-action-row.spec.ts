/**
 * Extension card action row — BOUNDING-BOX geometry proof (cinatra#2363,
 * spec design#105 §I).
 *
 * Why a browser suite exists for this at all: "the install control and More
 * details sit side by side, details on the right" is a LAYOUT claim. Static
 * markup can prove the two controls share one flex container in the right DOM
 * order (that is locked in
 * packages/extensions/src/__tests__/marketplace-listing-card-action-row.test.tsx),
 * but only a layout engine can say whether they actually land on one line at
 * the widths the app's own grid produces — which is the entire question, since
 * the controls are `shrink-0 whitespace-nowrap` and the card body is narrow.
 *
 * The contract being proven, in the spec's own words: one line is "the resting
 * layout for the label set the app's own breakpoints actually carry — it wraps
 * to a second line only when a control's label runs long enough to force it (a
 * longer pending state, or a narrower card at a smaller breakpoint)". That is
 * a CONDITIONAL guarantee, and it is asserted in two layers:
 *
 *   1. INVARIANTS, at every breakpoint in every state: the row never overflows
 *      the card, the pair is never re-ordered, a one-line pair has details
 *      strictly to the right with no overlap, and a wrapped pair sits cleanly
 *      on a second line rather than half-overlapping.
 *   2. The ARRANGEMENT MATRIX (see EXPECTED), pinned per breakpoint per state
 *      from measured behaviour — and, at the same time, cross-checked against
 *      the measured widths: a one-line cell must actually FIT, and a wrapped
 *      cell must actually OVERFLOW. That second half is what makes the matrix
 *      a contract rather than a snapshot. It gives the "wrap only on genuine
 *      overflow" clause real teeth (a wrap caused by anything other than the
 *      pair being too wide — a stray flex-basis, a `w-full` on a control — is
 *      red even though the arrangement still "matches"), and it keeps the
 *      suite honest across font-rendering drift instead of pinning pixels.
 *
 * The pending state is measured with the REAL busy control on screen
 * ("Installing…" plus its spinner, the widest control in the set), reached by
 * driving the real form — not by simulating a class.
 *
 * Surface: /design-fixtures/conformance. Three things make a card there the
 * same width as a card on the live /configuration/extensions grid, which is
 * the only reason these numbers mean anything:
 *   - the fixture grid uses the live column ramp (1 / sm:2 / lg:3 / xl:4);
 *   - its "More details" placeholder carries the LIVE trigger's exact classes;
 *   - the section is mounted directly inside `PageContent`, NOT inside a Card
 *     like its neighbours — a Card's `px-4` plus border took ~17px off every
 *     cell and made an earlier version of this suite pin a layout narrower
 *     than the app ever renders (it had "Update now" wrapping at xl, which the
 *     live grid does not do).
 * The sidebar is pinned EXPANDED, because a collapsed sidebar hands the grid
 * ~190 more pixels and would quietly prove the easy case.
 *
 * Every measured width is attached to the report, so the PR can cite real
 * numbers instead of the issue's pre-drift estimates.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const HARNESS_PATH = "/design-fixtures/conformance";

/** Tailwind's own breakpoints — the ones the grid ramp keys off. */
const BREAKPOINTS = [
  { name: "md", width: 768 },
  { name: "lg", width: 1024 },
  { name: "xl", width: 1280 },
] as const;

type BreakpointName = (typeof BREAKPOINTS)[number]["name"];

/**
 * The six CTA states, by the fixture surface that renders each. `pending`
 * marks the one state that has to be DRIVEN (the busy control only exists
 * while a real submission is in flight).
 */
const SURFACES = [
  { id: "extension-listing-card-available", label: "Install now" },
  { id: "extension-listing-card-installed", label: "Installed" },
  { id: "extension-listing-card-update", label: "Update now" },
  { id: "extension-listing-card-restore", label: "Restore" },
  { id: "extension-listing-card-incompatible", label: "Install now" },
  { id: "extension-listing-card-installing", label: "Installing…", pending: true },
] as const;

type Arrangement = "one-line" | "wrapped";

/**
 * The pinned arrangement matrix, measured on this branch (Chromium, expanded
 * sidebar) and reproduced in each run's JSON attachment:
 *
 *   breakpoint   card     row      what fits (cta + 10px gap + 85.5px details)
 *   md  768px   200.0px  170.0px   Installed (167.2) and Restore (162.2) only
 *   lg 1024px   234.7px  204.7px   ALL SIX, incl. Installing… (200.2)
 *   xl 1280px   236.0px  206.0px   ALL SIX
 *
 * Needs, for reference: Restore 162.2 · Installed 167.2 · Install now 181.0 ·
 * Update now 189.1 · Installing… 200.2.
 *
 * That reads back as the spec sentence: one line for the label set the app's
 * own breakpoints carry, wrapping only where "a control's label runs long
 * enough to force it… a narrower card at a smaller breakpoint". At md the
 * expanded sidebar leaves a 170px row and the four widest states take a second
 * line — the narrow-card clause, not a defect; the invariants still hold in
 * every one of those cells.
 *
 * Change a cell only after re-grounding the widths — the fit cross-check will
 * already have told you whether the pair genuinely stopped fitting.
 */
const EXPECTED: Record<BreakpointName, Record<string, Arrangement>> = {
  md: {
    "extension-listing-card-available": "wrapped",
    "extension-listing-card-installed": "one-line",
    "extension-listing-card-update": "wrapped",
    "extension-listing-card-restore": "one-line",
    "extension-listing-card-incompatible": "wrapped",
    "extension-listing-card-installing": "wrapped",
  },
  lg: {
    "extension-listing-card-available": "one-line",
    "extension-listing-card-installed": "one-line",
    "extension-listing-card-update": "one-line",
    "extension-listing-card-restore": "one-line",
    "extension-listing-card-incompatible": "one-line",
    "extension-listing-card-installing": "one-line",
  },
  xl: {
    "extension-listing-card-available": "one-line",
    "extension-listing-card-installed": "one-line",
    "extension-listing-card-update": "one-line",
    "extension-listing-card-restore": "one-line",
    "extension-listing-card-incompatible": "one-line",
    "extension-listing-card-installing": "one-line",
  },
};

type Box = { x: number; y: number; width: number; height: number };

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const centerY = (b: Box) => b.y + b.height / 2;

/** Sub-pixel slack: layout maths lands on fractional device pixels. */
const EPS = 1.5;

/** The action row's gap in the §I drawing: `gap: 10px`. */
const SPEC_ROW_GAP_PX = 10;

/**
 * The row's own column gap, read from the DOM rather than hardcoded — the
 * third term of the fit calculation, and the one most likely to be retuned.
 * Reading it keeps the fit maths true to whatever the row actually declares;
 * it is separately asserted against the spec value.
 */
async function columnGapOf(row: Locator): Promise<number> {
  return row.evaluate((el) => parseFloat(getComputedStyle(el).columnGap) || 0);
}

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b, "element has a layout box").not.toBeNull();
  return b!;
}

/**
 * Pin the sidebar EXPANDED before the first paint. The provider seeds from the
 * `sidebar_state` cookie, so setting it up front avoids both a collapsed rail
 * and a post-hydration width jump mid-measurement.
 */
async function openHarness(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 1000 });
  await page.context().addCookies([
    {
      name: "sidebar_state",
      value: "true",
      url: page.url().startsWith("http") ? new URL(page.url()).origin : "http://localhost",
    },
  ]);
  await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-surface-id="extension-listing-card-available"]'),
  ).toBeVisible();
  // Fonts decide button widths; measuring before they settle measures the
  // fallback face.
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
}

function cardOf(page: Page, surfaceId: string): Locator {
  return page.locator(`[data-surface-id="${surfaceId}"]`);
}

/** The row's two measurable children: the interactive control, and details. */
function controlsOf(card: Locator): { cta: Locator; details: Locator; row: Locator } {
  return {
    // The CTA slot is `display: contents` and therefore has NO box of its own
    // — measuring it would return null. The real control is the flex item's
    // content, so the button is what gets measured.
    cta: card.locator('[data-testid="extension-card-cta"] button'),
    details: card.locator('[data-slot="extension-card-actions"]').getByRole("button", {
      name: "More details",
      exact: true,
    }),
    row: card.locator('[data-slot="extension-card-actions"]'),
  };
}

/**
 * The shared per-state geometry contract, asserted at every breakpoint for
 * every state. Returns the observed line arrangement so the caller can apply
 * the breakpoint-specific guarantee on top.
 */
async function assertRowGeometry(
  card: Locator,
  label: string,
  context: string,
): Promise<{
  arrangement: Arrangement;
  cardWidth: number;
  rowWidth: number;
  needed: number;
}> {
  const { cta, details, row } = controlsOf(card);
  await expect(cta, `${context}: the CTA control renders`).toBeVisible();
  await expect(details, `${context}: More details renders`).toBeVisible();
  await expect(cta).toHaveText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const ctaBox = await box(cta);
  const detailsBox = await box(details);
  const rowBox = await box(row);

  // 1. CONTAINMENT — the row never bleeds out of the card at any width. This
  //    is what `min-w-0` on the row buys, and the failure it prevents (a
  //    horizontally clipped or overhanging control) is invisible to a DOM-only
  //    test.
  const cardBox = await box(card);
  expect(rowBox.x, `${context}: row starts inside the card`).toBeGreaterThanOrEqual(
    cardBox.x - EPS,
  );
  expect(right(rowBox), `${context}: row ends inside the card`).toBeLessThanOrEqual(
    right(cardBox) + EPS,
  );
  for (const [name, b] of [
    ["CTA", ctaBox],
    ["details", detailsBox],
  ] as const) {
    expect(b.x, `${context}: ${name} starts inside the card`).toBeGreaterThanOrEqual(
      cardBox.x - EPS,
    );
    expect(right(b), `${context}: ${name} ends inside the card`).toBeLessThanOrEqual(
      right(cardBox) + EPS,
    );
  }

  // 2. ORDER — details is never above the control, in either arrangement.
  expect(detailsBox.y, `${context}: details is never above the CTA`).toBeGreaterThanOrEqual(
    ctaBox.y - EPS,
  );

  // 3. WHAT THE PAIR NEEDS vs WHAT THE ROW HAS. This is the quantity the whole
  //    contract turns on, so every term is measured and reported.
  //
  //    The gap is also PINNED to the spec's 10px (`.btn` row gap in the §I
  //    drawing). Reading it without asserting it would let a silent retune to
  //    8px slip through: the matrix would still pass, because 2px does not flip
  //    any current cell — but the row would no longer be the drawn row, and the
  //    next label change would land on the wrong side of the fit boundary.
  const gap = await columnGapOf(row);
  expect(gap, `${context}: the action row keeps the spec's 10px gap`).toBeCloseTo(
    SPEC_ROW_GAP_PX,
    1,
  );
  const needed = ctaBox.width + gap + detailsBox.width;
  const fits = needed <= rowBox.width + EPS;

  const sameLine = Math.abs(centerY(ctaBox) - centerY(detailsBox)) <= 2;
  if (sameLine) {
    // 4a. ONE LINE — details strictly to the RIGHT, with a real gap and no
    //     overlap. `>=` on the CTA's right edge is the whole "details right"
    //     claim, measured rather than inferred from DOM order.
    expect(
      detailsBox.x,
      `${context}: details sits to the RIGHT of the CTA, not overlapping it`,
    ).toBeGreaterThanOrEqual(right(ctaBox) - EPS);
    expect(
      fits,
      `${context}: a one-line pair must actually fit (needs ${needed.toFixed(1)}px of ${rowBox.width.toFixed(1)}px)`,
    ).toBe(true);
  } else {
    // 4b. WRAPPED — a clean second line: details fully below the control, not
    //     a partial overlap (which would read as a broken row rather than a
    //     deliberate wrap) — and wrapped for the ONLY sanctioned reason, that
    //     the pair does not fit. A wrap with room to spare means something
    //     other than overflow forced it.
    expect(
      detailsBox.y,
      `${context}: a wrapped details starts below the CTA`,
    ).toBeGreaterThanOrEqual(bottom(ctaBox) - EPS);
    expect(
      fits,
      `${context}: wrapped although the pair FITS (needs ${needed.toFixed(1)}px of ${rowBox.width.toFixed(1)}px) — wrap must only ever be genuine overflow`,
    ).toBe(false);
  }

  const cardWidth = (await box(card.locator('[data-testid="extension-listing-card"]'))).width;
  return {
    arrangement: sameLine ? "one-line" : "wrapped",
    cardWidth,
    rowWidth: rowBox.width,
    needed,
  };
}

/**
 * Drive the REAL install form into its busy state and hold it there long
 * enough to measure. The installing fixture's action takes 8s, so the pending
 * control is on screen for the measurement without any clock faking.
 */
async function enterPendingState(card: Locator): Promise<void> {
  const submit = card.locator('[data-testid="extension-card-cta-submit"]');
  await expect(async () => {
    await submit.click();
    await expect(card.locator('[data-testid="extension-card-cta-submit"][data-pending]')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
}

for (const bp of BREAKPOINTS) {
  test.describe(`action row @ ${bp.name} (${bp.width}px, sidebar expanded)`, () => {
    test("all six CTA states satisfy the geometry contract", async ({ page }, testInfo) => {
      await openHarness(page, bp.width);

      const measured: Record<string, unknown> = {};

      for (const surface of SURFACES) {
        const card = cardOf(page, surface.id);
        if ("pending" in surface && surface.pending) {
          await enterPendingState(card);
        }
        const result = await assertRowGeometry(
          card,
          surface.label,
          `${bp.name}/${surface.id}`,
        );
        measured[surface.id] = {
          label: surface.label,
          arrangement: result.arrangement,
          cardWidth: Number(result.cardWidth.toFixed(1)),
          rowWidth: Number(result.rowWidth.toFixed(1)),
          pairNeeds: Number(result.needed.toFixed(1)),
        };

        // The pinned matrix. Paired with the fit cross-check inside
        // assertRowGeometry, this says both WHAT the layout does and WHY.
        expect(
          result.arrangement,
          `${bp.name}/${surface.id}: arrangement changed (pair needs ${result.needed.toFixed(1)}px of ${result.rowWidth.toFixed(1)}px) — re-ground the widths before re-pinning`,
        ).toBe(EXPECTED[bp.name][surface.id]);
      }

      await testInfo.attach(`action-row-geometry-${bp.name}.json`, {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({ breakpoint: bp.name, viewport: bp.width, measured }, null, 2),
        ),
      });
    });

    test("the pinned CTA-slot contract survives the row at this width", async ({ page }) => {
      await openHarness(page, bp.width);
      for (const surface of SURFACES) {
        const card = cardOf(page, surface.id);
        const slot = card.locator('[data-testid="extension-card-cta"]');
        // The slot is inside the action row (not a sibling of it) and still
        // adds zero layout impact — `display: contents` means it has no box,
        // so the CONTROL is the flex item.
        await expect(
          card.locator('[data-slot="extension-card-actions"] [data-testid="extension-card-cta"]'),
        ).toHaveCount(1);
        await expect(slot).toHaveAttribute("data-cta-state", /.+/);
        expect(
          await slot.evaluate((el) => getComputedStyle(el).display),
          `${bp.name}/${surface.id}: CTA slot stays display:contents`,
        ).toBe("contents");
      }
    });

    test("the price keeps its own line above the row", async ({ page }) => {
      await openHarness(page, bp.width);
      for (const surface of SURFACES) {
        const card = cardOf(page, surface.id);
        const price = card.locator('[data-slot="extension-card-price"]');
        if ((await price.count()) === 0) continue;
        const priceBox = await box(price);
        const rowBox = await box(card.locator('[data-slot="extension-card-actions"]'));
        expect(
          bottom(priceBox),
          `${bp.name}/${surface.id}: the price line sits entirely above the action row`,
        ).toBeLessThanOrEqual(rowBox.y + EPS);
      }
    });
  });
}

test.describe("action row — tab order", () => {
  test("focus reaches the CTA before More details", async ({ page }) => {
    await openHarness(page, 1280);
    const card = cardOf(page, "extension-listing-card-available");
    const { cta, details } = controlsOf(card);
    await cta.focus();
    await expect(cta).toBeFocused();
    await page.keyboard.press("Tab");
    // Details is the very next tab stop inside the card — moving it beside the
    // CTA must not have re-sequenced the keyboard path.
    await expect(details).toBeFocused();
  });
});
