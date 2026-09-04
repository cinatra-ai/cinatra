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
 * by the design harness).
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
 *   4. THE DRAWN STEP BOX — a reason-free row's TRIGGER box measures exactly
 *      the 28px the rail is drawn at (".rail .step { padding: 2px 0 }" over the
 *      24px circle), on the mixed rail, the single-line lifecycle rail and the
 *      lifecycle-free control rail. This claim used to read 2rem, because the
 *      shared Button's fixed `h-8` outranked the rail's own padding and pinned
 *      every step row 4px over the drawing; the Button now draws a padding box
 *      and no height, so the rail measures what it states. See
 *      `STEP_ROW_HEIGHT` for the full reading.
 *      Read the scope precisely: it is the trigger box (`ROW_BOX`) that is
 *      28px, not the enclosing StepperItem — an item that still has a
 *      following separator measures 40px (28 + the `!h-2` separator + its
 *      margins), and only the LAST item of a rail measures 28px. And a
 *      lifecycle row is never a bare step box even when its reason does not
 *      wrap: the reason is a block beneath the label, so that row is honestly
 *      two lines (measured 38px). "Exactly 28px" is a claim about reason-free
 *      TRIGGER boxes and nothing wider.
 *   5. FIRST-LINE ALIGNMENT — a lifecycle row's indicator centres on the FIRST
 *      LINE of its title, for a wrapped reason AND for a SHORT one that does
 *      not wrap. The fix applies `items-start` to EVERY lifecycle trigger, so
 *      the non-wrapping row is the case that could regress silently, and it is
 *      the ONE claim here that catches it: measured on pre-fix markup, a
 *      single-line lifecycle row still boxes at 32px and leaves its reason
 *      flush with the row's bottom edge, so containment (1) and intrusion (2)
 *      both PASS on it — while the indicator's centre lands 1px past the end
 *      of the first line. Pre-fix the wrapped rows miss by 33px.
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
const TITLE = '[data-slot="stepper-title"]';
const REASON = "[data-rail-lifecycle-reason]";
const LIFECYCLE_ROW = '[data-rail-kind="lifecycleDecision"]';
const STEP_ROW = '[data-rail-kind="step"]';

/**
 * THE ORDINARY STEP ROW'S BOX, as the ratified drawing states it:
 *
 *   ".rail .step { ... padding: 2px 0; ... }"
 *
 * over the 24px indicator circle is a 28px entry and nothing else.
 *
 * This constant used to read 32 and called itself "the 2rem (`h-8`) row box
 * every ordinary single-line rail row has always had". That 2rem was never the
 * drawing's number: it was the shared Button's fixed `h-8`, which outranked the
 * rail's own `py-0.5` and pinned every step row 4px taller than the drawn step.
 * The rail already states the drawn box itself — `RUN_PAGE_RAIL_ROW_CLASS` is
 * `gap-2 border-0 px-0 py-0.5`, and its own note reads "a 28px entry and
 * nothing else" — so the 2rem was the Button overriding the rail, not the rail
 * asking for it.
 *
 * This PR removes that fixed height from the Button (the components drawing
 * states a 7px 14px padding box, not a height), and the step row falls to the
 * 28px its own drawing rule always asked for. So the claim below is NOT
 * relaxed, it is RE-ANCHORED: it moves off a height the Button happened to
 * impose and onto the height the rail is drawn at, and it is now the assertion
 * that catches a height floor creeping back into the shared primitive.
 */
const STEP_ROW_HEIGHT = 28;

/**
 * The 2rem floor a LIFECYCLE row still keeps, and the bound a wrapped row must
 * grow past. It is no longer the Button's: `RailExtraEntry` states `h-auto
 * min-h-8` on its own trigger, so the floor survives the Button losing `h-8`.
 * Both claims that used this number keep it unchanged.
 */
const LIFECYCLE_ROW_FLOOR = 32;

/** Sub-pixel slack: fractional layout values must not be read as an overlap. */
const EPSILON = 0.5;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "element must be laid out and visible").not.toBeNull();
  return box!;
}

/**
 * The FIRST LINE box of a row's title, and the vertical centre of that row's
 * indicator — the pair the alignment claim is made of.
 *
 * The first line is read as the first client rect of the title's contents
 * (`Range.getClientRects()` returns one rect per line box), so it is the real
 * laid-out first line rather than an assumption about line-height. A title with
 * a wrapped reason produces several rects; a plain step row produces one.
 */
async function firstLineAndIndicator(row: Locator) {
  return row.evaluate(
    (el, sel) => {
      const title = el.querySelector(sel.title)!;
      const indicator = el.querySelector(sel.indicator)!;
      const range = document.createRange();
      range.selectNodeContents(title);
      const firstLine = range.getClientRects()[0];
      const ind = indicator.getBoundingClientRect();
      return {
        firstLineTop: firstLine.top,
        firstLineBottom: firstLine.bottom,
        indicatorCentre: ind.top + ind.height / 2,
      };
    },
    { title: TITLE, indicator: INDICATOR }
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
      ).toBeGreaterThan(LIFECYCLE_ROW_FLOOR);
    });

    test("a lifecycle indicator centres on the first line, wrapped reason or not", async ({
      page,
    }) => {
      // Both lifecycle cases, plus an ordinary step row as the control that has
      // always had this alignment.
      const rowWith = (rail: string, inner: string) =>
        page
          .locator(`${rail} ${ROW}`)
          .filter({ has: page.locator(inner) })
          .first();

      const cases = [
        { name: "wrapped lifecycle row", row: rowWith(WRAPPED_RAIL, REASON) },
        { name: "single-line lifecycle row", row: rowWith(SINGLE_LINE_RAIL, REASON) },
        { name: "ordinary step row (control)", row: rowWith(SINGLE_LINE_RAIL, STEP_ROW) },
      ];

      for (const { name, row } of cases) {
        await expect(row, `${name} must exist`).toHaveCount(1);
        const { firstLineTop, firstLineBottom, indicatorCentre } =
          await firstLineAndIndicator(row);

        // The indicator belongs on the FIRST line, not centred against the
        // whole block. Pre-fix the single-line row misses by 1px and the
        // wrapped row by 33px.
        expect(
          indicatorCentre,
          `${name}: the indicator must not sit above its title's first line`
        ).toBeGreaterThanOrEqual(firstLineTop - EPSILON);
        expect(
          indicatorCentre,
          `${name}: the indicator must not sit below its title's first line`
        ).toBeLessThanOrEqual(firstLineBottom + EPSILON);
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
      ).toBeGreaterThanOrEqual(LIFECYCLE_ROW_FLOOR - EPSILON);
      // ...and it must stay strictly shorter than a row whose reason wraps,
      // i.e. the row grew by ITS OWN content and not by a shared constant.
      expect(
        shortRowBox.height,
        "a single-line lifecycle row must be shorter than a wrapped one"
      ).toBeLessThan(wrappedRowBox.height);
    });

    test("rows without a reason draw the drawing's own step box", async ({ page }) => {
      for (const rail of [WRAPPED_RAIL, SINGLE_LINE_RAIL, PLAIN_RAIL]) {
        const stepRows = page.locator(`${rail} ${STEP_ROW} ${ROW_BOX}`);
        const count = await stepRows.count();
        expect(count, `${rail} must render its ordinary step rows`).toBeGreaterThan(0);

        for (let i = 0; i < count; i += 1) {
          const box = await boxOf(stepRows.nth(i));
          expect(
            box.height,
            `${rail} step row ${i} must draw the drawing's 28px step box`
          ).toBeCloseTo(STEP_ROW_HEIGHT, 0);
        }
      }
    });
  });
}
