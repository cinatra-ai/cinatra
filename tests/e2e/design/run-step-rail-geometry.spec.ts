/**
 * Run step rail — wrapped policy reason row geometry (cinatra#2840).
 *
 * The reported defect: on the run page, a step-rail row whose lifecycle policy
 * reason wraps to several lines printed ON TOP of the rows beneath it — labels
 * and reasons overlapping, the bottom of the rail unreadable.
 *
 * Root cause: the rail row's only height constraint was the shared Button's
 * default fixed `h-8` inside `StepperTrigger`. The wrapped reason overflowed
 * that pinned 2rem box while the StepperItem — and therefore the next row's
 * offset — was still measured from the 2rem, so anything taller printed over
 * the row below.
 *
 * This is a LAYOUT claim, so it is asserted on real bounding boxes in a real
 * browser against the fixture route `/design-fixtures/run-step-rail`; a jsdom
 * component test cannot compute any of it (jsdom has no layout engine and
 * reports every box as 0×0). Assertion-based on purpose — no pixel baselines
 * here, so the spec stays platform-portable (the pixel baselines remain owned
 * by design-fixtures.spec.ts).
 *
 * Six claims, at a desktop AND a narrow viewport. Every one was checked against
 * pre-fix markup (the same rail with the row's `h-8 items-center` restored), so
 * the suite is known to FAIL without the fix rather than merely passing with it.
 * The ones that pass pre-fix too are the deliberate CONTROLS — "ordinary rows
 * are unchanged" (4), the ordinary-step-row arm of (5), and the fixture's own
 * "this reason really is one line" contract in (6):
 *   1. CONTAINMENT — each wrapped reason's box sits INSIDE its own row box.
 *      Pre-fix an 80px and a 96px reason sat in a 32px row, escaping it by
 *      32px and 40px.
 *   2. NO INTRUSION — no reason's box vertically overlaps ANY other rail row.
 *      This is the user-visible claim, and it is the assertion that catches
 *      the defect: because the pinned row centred its overflowing content,
 *      each reason painted into the row ABOVE and the row BELOW (16–28px
 *      pre-fix) — "labels and reasons print on top of each other".
 *      NOTE: comparing consecutive ROW BOXES instead would prove nothing —
 *      the row boxes stay stacked and disjoint even pre-fix; it is the text
 *      that escapes them.
 *   3. PUSH-DOWN — a row carrying a genuinely wrapped (≥2 line) reason is
 *      taller than an ordinary single-line row, i.e. the rail GREW rather
 *      than clamping the text away. Pre-fix every row measured 32px.
 *   4. UNCHANGED — a reason-free row's TRIGGER box still measures exactly the
 *      2rem it always had (the `min-h-8` floor), on the mixed rail, the
 *      single-line lifecycle rail and the lifecycle-free control rail.
 *      Read the scope precisely: it is the trigger box (`ROW_BOX`) that is
 *      2rem, not the enclosing StepperItem — an item that still has a
 *      following separator measures 44px (32 + the `!h-2` separator + its
 *      margins), and only the LAST item of a rail measures 32px. And a
 *      lifecycle row is never 2rem even when its reason does not wrap: the
 *      reason is a block beneath the label, so that row is honestly two lines
 *      (measured 38px). "Exactly 32px" is a claim about reason-free TRIGGER
 *      boxes and nothing wider.
 *   5. CENTRED IN ITS OWN ROW BOX — a lifecycle row's indicator centres on
 *      the row box it sits in, for a wrapped reason AND for a SHORT one that
 *      does not wrap. This is the drawing's own rule and nothing looser:
 *      `.rail .step { display: flex; align-items: center; gap: 8px; padding:
 *      2px 0; ... }` centres the 24px mark in the row's OWN box, so the mark's
 *      centre and the row box's centre are ONE number however many line boxes
 *      the title wraps to. Read the scope precisely: the row box is the
 *      TRIGGER box (`ROW_BOX`), the drawn `.rail .step`, not the enclosing
 *      StepperItem whose box also carries the following separator.
 *        This claim REPLACES an earlier first-line reading — "the indicator
 *      centres on the FIRST LINE of its title" — which pinned the mark to the
 *      title's first line box and is not what the drawing composes. Measured
 *      on this fixture with that earlier composition restored (`items-start`
 *      on the row box, `mt-0.5 leading-5` on the title), at BOTH viewports:
 *      the wrapped row's mark centres at 324.078 in a row box centred on
 *      364.578 — 40.5px above its own box — and the single-line lifecycle
 *      row's mark at 280.078 against a box centred on 288.578, 8.5px above.
 *      Both are cases this claim catches. Only the ORDINARY STEP ROW is a
 *      control here (mark and box centre both 236.078 either way): its box is
 *      one line, so the two readings coincide. A lifecycle row is never a
 *      one-line box — its reason is a block beneath the label — so the
 *      "single-line" lifecycle arm is a real case, not a control.
 *   6. ONE EXTRA LINE — a short, non-wrapping reason grows its row by its own
 *      single line and no more: at least the 2rem floor, strictly shorter than
 *      a wrapped row. NOTE that a lifecycle row is NOT a 32px row even when the
 *      reason fits on one line — the reason is a `block` beneath the label, so
 *      the honest content height is two lines (measured 38px). Pre-fix that row
 *      reported 32px only because it was pinned there and overflowed.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/run-step-rail";

const WRAPPED_RAIL = '[data-surface-id="run-step-rail-wrapped"]';
const SINGLE_LINE_RAIL = '[data-surface-id="run-step-rail-single-line"]';
const PLAIN_RAIL = '[data-surface-id="run-step-rail-plain"]';

const ROW = '[data-slot="stepper-item"]';
const ROW_BOX = '[data-slot="stepper-trigger"]';
const INDICATOR = '[data-slot="stepper-indicator"]';
const REASON = "[data-rail-lifecycle-reason]";
const LIFECYCLE_ROW = '[data-rail-kind="lifecycleDecision"]';
const STEP_ROW = '[data-rail-kind="step"]';

/**
 * The single-line rail row box: a 24px circle with the drawing's own 2px above
 * and below it.
 *
 * IT WAS 32px HERE UNTIL cinatra#3225. That was the shared button's fixed `h-8`,
 * which the rail's row class no longer takes — the drawing's `.rail .step {
 * padding: 2px 0 }` over the circle is 28px and nothing else — so the constant
 * follows the drawn row rather than the primitive it used to inherit. Measured
 * on the fixture route at both viewports: 28px.
 */
const SINGLE_LINE_ROW_HEIGHT = 28;

/** Sub-pixel slack: fractional layout values must not be read as an overlap. */
const EPSILON = 0.5;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "element must be laid out and visible").not.toBeNull();
  return box!;
}

/**
 * A row's own ROW BOX, and the vertical centre of that row's indicator — the
 * pair the centring claim is made of.
 *
 * Both rects are read in ONE evaluate so they share a single layout, and the
 * row box read is the trigger (`ROW_BOX`) — the drawn `.rail .step` — rather
 * than the enclosing StepperItem, whose box also spans the following
 * separator.
 *
 * The row's own HEIGHT comes back with them, because that is what tells a
 * genuinely wrapped row from a one-line one. Counting the title's client rects
 * would NOT: the title element carries the lifecycle reason block inside it,
 * so `Range.getClientRects()` over its contents returns one rect per nested
 * box (measured 9 on the wrapped row and 5 on the single-line one), not one
 * rect per line.
 */
async function rowBoxAndIndicator(row: Locator) {
  return row.evaluate(
    (el, sel) => {
      const rowBox = el.querySelector(sel.rowBox)!.getBoundingClientRect();
      const ind = el.querySelector(sel.indicator)!.getBoundingClientRect();
      return {
        rowBoxTop: rowBox.top,
        rowBoxHeight: rowBox.height,
        rowBoxCentre: rowBox.top + rowBox.height / 2,
        indicatorCentre: ind.top + ind.height / 2,
      };
    },
    { rowBox: ROW_BOX, indicator: INDICATOR }
  );
}

/**
 * Two viewports: the desktop width the report names, and a narrow one.
 *
 * Be accurate about what the narrow arm buys. It does NOT wrap the reason to
 * more lines: the rail is a FIXED-WIDTH column (`w-52` on the panel's root,
 * run-step-rail-panel.tsx:73) and the reason column inside it is a fixed
 * `max-w-36`, so the wrap point does not move with the viewport. Measured on
 * this fixture, the row heights at 900px are IDENTICAL to those at 1440px
 * ([44, 44, 98, 114, 32] on the wrapped rail at both).
 *
 * So the 900px arm is a REGRESSION GUARD that the fix's geometry is
 * viewport-independent — worth asserting, because a future clamp or a
 * responsive width on the rail would break exactly here. It is not evidence
 * about narrower wrapping, and this suite does not claim to be.
 */
const VIEWPORTS = [
  { name: "desktop 1440x900", width: 1440, height: 900 },
  { name: "narrow 900x900", width: 900, height: 900 },
];

async function openFixture(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(FIXTURE_PATH);
  // The rail is client-rendered; wait for the rows themselves, not the route.
  await expect(page.locator(`${WRAPPED_RAIL} ${ROW}`).first()).toBeVisible();
  // Fonts settle the wrap point, and the wrap point IS the measurement.
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of VIEWPORTS) {
  test.describe(`step rail row geometry — ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await openFixture(page, viewport.width, viewport.height);
    });

    test("a wrapped policy reason stays inside its own row box", async ({ page }) => {
      const reasons = page.locator(`${WRAPPED_RAIL} ${REASON}`);
      await expect(reasons).toHaveCount(2);

      for (let i = 0; i < 2; i += 1) {
        const reason = reasons.nth(i);
        // The row box is the trigger the reason is rendered inside — the box
        // that used to be pinned to 2rem.
        const rowBox = await boxOf(
          reason.locator(`xpath=ancestor::*[@data-slot="stepper-trigger"][1]`)
        );
        const reasonBox = await boxOf(reason);

        // The reason must genuinely WRAP, or this spec proves nothing.
        expect(
          reasonBox.height,
          `reason ${i} must wrap to more than one line to be a real case`
        ).toBeGreaterThan(20);

        expect(
          reasonBox.y + reasonBox.height,
          `reason ${i} must not escape the bottom of its row box`
        ).toBeLessThanOrEqual(rowBox.y + rowBox.height + EPSILON);
        expect(
          reasonBox.y,
          `reason ${i} must not escape the top of its row box`
        ).toBeGreaterThanOrEqual(rowBox.y - EPSILON);
      }
    });

    test("a wrapped reason never paints into another rail row", async ({ page }) => {
      const rows = page.locator(`${WRAPPED_RAIL} ${ROW}`);
      expect(await rows.count()).toBe(5);

      const rowBoxes: Box[] = [];
      for (let i = 0; i < 5; i += 1) {
        rowBoxes.push(await boxOf(rows.nth(i)));
      }

      const reasons = page.locator(`${WRAPPED_RAIL} ${REASON}`);
      await expect(reasons).toHaveCount(2);

      for (let r = 0; r < 2; r += 1) {
        const reason = reasons.nth(r);
        const reasonBox = await boxOf(reason);
        // Which row does this reason belong to? Every other row is off limits.
        const ownRowIndex = await reason.evaluate((el) => {
          const own = el.closest('[data-slot="stepper-item"]');
          const rail = el.closest("[data-surface-id]")!;
          return [...rail.querySelectorAll('[data-slot="stepper-item"]')].indexOf(
            own as Element
          );
        });

        for (let i = 0; i < rowBoxes.length; i += 1) {
          if (i === ownRowIndex) continue;
          const other = rowBoxes[i];
          const verticalOverlap =
            Math.min(reasonBox.y + reasonBox.height, other.y + other.height) -
            Math.max(reasonBox.y, other.y);
          expect(
            verticalOverlap,
            `the reason in row ${ownRowIndex} must not paint into row ${i}`
          ).toBeLessThanOrEqual(EPSILON);
        }
      }
    });

    test("a wrapped reason grows its row instead of being clamped away", async ({ page }) => {
      const lifecycleRowBox = await boxOf(
        page.locator(`${WRAPPED_RAIL} ${LIFECYCLE_ROW} ${ROW_BOX}`).first()
      );
      const stepRowBox = await boxOf(
        page.locator(`${WRAPPED_RAIL} ${STEP_ROW} ${ROW_BOX}`).first()
      );

      expect(
        lifecycleRowBox.height,
        "a row carrying a wrapped reason must be taller than a single-line row"
      ).toBeGreaterThan(stepRowBox.height);
      expect(
        lifecycleRowBox.height,
        "a wrapped reason must make its row grow past the old fixed row height"
      ).toBeGreaterThan(SINGLE_LINE_ROW_HEIGHT);
    });

    test("a lifecycle indicator centres in its own row box, wrapped reason or not", async ({
      page,
    }) => {
      // Both lifecycle cases, plus an ordinary step row as the control whose
      // one-line box has the same centre under either composition.
      const rowWith = (rail: string, inner: string) =>
        page
          .locator(`${rail} ${ROW}`)
          .filter({ has: page.locator(inner) })
          .first();

      const cases = [
        {
          name: "wrapped lifecycle row",
          row: rowWith(WRAPPED_RAIL, REASON),
          mustExceedOneLine: true,
        },
        {
          name: "single-line lifecycle row",
          row: rowWith(SINGLE_LINE_RAIL, REASON),
          mustExceedOneLine: true,
        },
        {
          name: "ordinary step row (control)",
          row: rowWith(SINGLE_LINE_RAIL, STEP_ROW),
          mustExceedOneLine: false,
        },
      ];

      for (const { name, row, mustExceedOneLine } of cases) {
        await expect(row, `${name} must exist`).toHaveCount(1);
        const { rowBoxCentre, rowBoxHeight, indicatorCentre } =
          await rowBoxAndIndicator(row);

        if (mustExceedOneLine) {
          // Without a genuinely taller-than-one-line row box the two readings
          // coincide and the case would prove nothing. BOTH lifecycle rows
          // clear it — a lifecycle row carries its reason as a block beneath
          // the label, so even the "single-line" one is a two-line box.
          expect(
            rowBoxHeight,
            `${name} must be taller than a single-line row box to be a real case`
          ).toBeGreaterThan(SINGLE_LINE_ROW_HEIGHT + EPSILON);
        }

        // `align-items: center` on the drawn row: the mark centres in the ROW
        // BOX, not on the title's first line. With the withdrawn first-line
        // composition restored on this fixture the wrapped row's mark lands
        // 40.5px above this centre and the single-line lifecycle row's 8.5px.
        expect(
          indicatorCentre,
          `${name}: the mark must not sit above its own row box's centre`
        ).toBeGreaterThanOrEqual(rowBoxCentre - EPSILON);
        expect(
          indicatorCentre,
          `${name}: the mark must not sit below its own row box's centre`
        ).toBeLessThanOrEqual(rowBoxCentre + EPSILON);
      }
    });

    test("a short reason grows its row by its own line and no more", async ({ page }) => {
      const shortReason = page.locator(`${SINGLE_LINE_RAIL} ${REASON}`);
      await expect(shortReason).toHaveCount(1);

      const reasonBox = await boxOf(shortReason);
      // The fixture's contract: this reason must NOT wrap, or the row is just
      // another copy of the wrapped case and proves nothing new.
      expect(
        reasonBox.height,
        "the single-line fixture's reason must occupy exactly one line box"
      ).toBeLessThanOrEqual(20);

      const shortRowBox = await boxOf(
        page.locator(`${SINGLE_LINE_RAIL} ${LIFECYCLE_ROW} ${ROW_BOX}`).first()
      );
      const wrappedRowBox = await boxOf(
        page.locator(`${WRAPPED_RAIL} ${LIFECYCLE_ROW} ${ROW_BOX}`).first()
      );

      // A lifecycle row is NOT a 32px row even unwrapped — the reason is a
      // block beneath the label — but it must never fall BELOW the floor...
      expect(
        shortRowBox.height,
        "a single-line lifecycle row must keep the 2rem min-h-8 floor"
      ).toBeGreaterThanOrEqual(SINGLE_LINE_ROW_HEIGHT - EPSILON);
      // ...and it must stay strictly shorter than a row whose reason wraps,
      // i.e. the row grew by ITS OWN content and not by a shared constant.
      expect(
        shortRowBox.height,
        "a single-line lifecycle row must be shorter than a wrapped one"
      ).toBeLessThan(wrappedRowBox.height);
    });

    test("rows without a reason keep the row box they always had", async ({ page }) => {
      for (const rail of [WRAPPED_RAIL, SINGLE_LINE_RAIL, PLAIN_RAIL]) {
        const stepRows = page.locator(`${rail} ${STEP_ROW} ${ROW_BOX}`);
        const count = await stepRows.count();
        expect(count, `${rail} must render its ordinary step rows`).toBeGreaterThan(0);

        for (let i = 0; i < count; i += 1) {
          const box = await boxOf(stepRows.nth(i));
          expect(
            box.height,
            `${rail} step row ${i} must keep the 2rem single-line row box`
          ).toBeCloseTo(SINGLE_LINE_ROW_HEIGHT, 0);
        }
      }
    });
  });
}
