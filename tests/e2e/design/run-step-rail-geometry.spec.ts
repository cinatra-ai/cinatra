/**
 * Run step rail — wrapped row geometry (cinatra#2840; re-pointed at the
 * wrapping NAME by cinatra#3149, fix leg 4).
 *
 * The reported defect: on the run page, a step-rail row whose text wrapped to
 * several lines printed ON TOP of the rows beneath it — names and rows
 * overlapping, the bottom of the rail unreadable.
 *
 * Root cause: the rail row's only height constraint was the shared Button's
 * default fixed `h-8` inside `StepperTrigger`. The wrapped text overflowed that
 * pinned 2rem box while the StepperItem — and therefore the next row's offset —
 * was still measured from the 2rem, so anything taller printed over the row
 * below.
 *
 * WHAT WRAPS HERE, AND WHY IT CHANGED. #2840 reported the defect on a lifecycle
 * POLICY REASON the rail drew as a second line beneath the entry's name. The
 * ratified drawing gives a rail entry a glyph and ONE name and no reason at all,
 * so leg 4 of cinatra#3149 removed that second line — and with it the only text
 * this suite had to wrap. The geometry it pins was never about the reason: it is
 * about ANY row whose text runs past the rail's fixed column, and the rail's own
 * names do exactly that (cinatra#3226 — "the row spans the rail column and may
 * SHRINK inside it, which is what lets a long label wrap instead of running past
 * the column"). So the wrapping subject is the entry's NAME, drawn in the row's
 * title, and every claim below reads the same geometry off it.
 *
 * This is a LAYOUT claim, so it is asserted on real bounding boxes in a real
 * browser against the fixture route `/design-fixtures/run-step-rail`; a jsdom
 * component test cannot compute any of it (jsdom has no layout engine and
 * reports every box as 0×0). Assertion-based on purpose — no pixel baselines
 * here, so the spec stays platform-portable (the pixel baselines remain owned
 * by design-fixtures.spec.ts).
 *
 * Six claims, at a desktop AND a narrow viewport. The ones that would pass on
 * the pre-fix markup too are the deliberate CONTROLS — "ordinary rows are
 * unchanged" (4), the ordinary-step-row arm of (5), and the fixture's own
 * "this name really is one line" contract in (6):
 *   1. CONTAINMENT — each wrapped name's box sits INSIDE its own row box.
 *      Pre-fix a multi-line name sat in a 32px row and escaped it.
 *   2. NO INTRUSION — no wrapped name's box vertically overlaps ANY other rail
 *      row. This is the user-visible claim, and it is the assertion that
 *      catches the defect: because the pinned row centred its overflowing
 *      content, the text painted into the row ABOVE and the row BELOW —
 *      "labels print on top of each other".
 *      NOTE: comparing consecutive ROW BOXES instead would prove nothing —
 *      the row boxes stay stacked and disjoint even pre-fix; it is the text
 *      that escapes them.
 *   3. PUSH-DOWN — a row carrying a genuinely wrapped (≥2 line) name is taller
 *      than an ordinary single-line row, i.e. the rail GREW rather than
 *      clamping the text away. Pre-fix every row measured 32px.
 *   4. UNCHANGED — a row whose name fits on one line keeps the TRIGGER box it
 *      always had, on the mixed rail, the single-line rail and the
 *      lifecycle-free control rail.
 *      Read the scope precisely: it is the trigger box (`ROW_BOX`) that is the
 *      single-line row, not the enclosing StepperItem, whose box also spans the
 *      following separator — only the LAST item of a rail measures the row
 *      alone.
 *   5. CENTRED IN ITS OWN ROW BOX — a row's indicator centres on the row box it
 *      sits in, for a wrapped name AND for one that does not wrap. This is the
 *      drawing's own rule and nothing looser: `.rail .step { display: flex;
 *      align-items: center; gap: 8px; padding: 2px 0; ... }` centres the 24px
 *      mark in the row's OWN box, so the mark's centre and the row box's centre
 *      are ONE number however many line boxes the title wraps to.
 *      This claim REPLACES an earlier first-line reading — "the indicator
 *      centres on the FIRST LINE of its title" — which pinned the mark to the
 *      title's first line box and is not what the drawing composes. Only the
 *      WRAPPED row is a real case for it; the one-line rows are controls, whose
 *      two readings coincide because their box is one line.
 *   6. NO SHARED CONSTANT — a row whose name fits on one line measures the
 *      single-line row box and is strictly shorter than a wrapped one, i.e.
 *      every row grew by ITS OWN content.
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
 * Be accurate about what the narrow arm buys. It does NOT wrap the name to more
 * lines: the rail is a FIXED-WIDTH column (`w-52` on the panel's root,
 * run-step-rail-panel.tsx:73), so the wrap point does not move with the
 * viewport and the row heights at 900px are the row heights at 1440px.
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

/**
 * The two rows of the WRAPPED rail whose names run past the rail's column.
 *
 * Read by position rather than by a selector of their own: the fixture is
 * deterministic and the rows around them are the controls, so an index says
 * exactly which row a claim is about without asking the product for a marker it
 * does not draw.
 */
const WRAPPED_ROW_INDEXES = [2, 3];

/** A single line of the rail's own title, with slack for the font's descenders. */
const ONE_LINE = 20;

for (const viewport of VIEWPORTS) {
  test.describe(`step rail row geometry — ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await openFixture(page, viewport.width, viewport.height);
    });

    test("a wrapped entry name stays inside its own row box", async ({ page }) => {
      const rows = page.locator(`${WRAPPED_RAIL} ${ROW}`);
      await expect(rows).toHaveCount(5);

      for (const index of WRAPPED_ROW_INDEXES) {
        const row = rows.nth(index);
        // The row box is the trigger the name is rendered inside — the box that
        // used to be pinned to 2rem.
        const rowBox = await boxOf(row.locator(ROW_BOX));
        const nameBox = await boxOf(row.locator(TITLE));

        // The name must genuinely WRAP, or this spec proves nothing.
        expect(
          nameBox.height,
          `row ${index}'s name must wrap to more than one line to be a real case`
        ).toBeGreaterThan(ONE_LINE);

        expect(
          nameBox.y + nameBox.height,
          `row ${index}'s name must not escape the bottom of its row box`
        ).toBeLessThanOrEqual(rowBox.y + rowBox.height + EPSILON);
        expect(
          nameBox.y,
          `row ${index}'s name must not escape the top of its row box`
        ).toBeGreaterThanOrEqual(rowBox.y - EPSILON);
      }
    });

    test("a wrapped name never paints into another rail row", async ({ page }) => {
      const rows = page.locator(`${WRAPPED_RAIL} ${ROW}`);
      expect(await rows.count()).toBe(5);

      const rowBoxes: Box[] = [];
      for (let i = 0; i < 5; i += 1) {
        rowBoxes.push(await boxOf(rows.nth(i)));
      }

      for (const ownRowIndex of WRAPPED_ROW_INDEXES) {
        const nameBox = await boxOf(rows.nth(ownRowIndex).locator(TITLE));

        for (let i = 0; i < rowBoxes.length; i += 1) {
          if (i === ownRowIndex) continue;
          const other = rowBoxes[i];
          const verticalOverlap =
            Math.min(nameBox.y + nameBox.height, other.y + other.height) -
            Math.max(nameBox.y, other.y);
          expect(
            verticalOverlap,
            `the name in row ${ownRowIndex} must not paint into row ${i}`
          ).toBeLessThanOrEqual(EPSILON);
        }
      }
    });

    test("a wrapped name grows its row instead of being clamped away", async ({ page }) => {
      const rows = page.locator(`${WRAPPED_RAIL} ${ROW}`);
      const wrappedRowBox = await boxOf(rows.nth(WRAPPED_ROW_INDEXES[0]).locator(ROW_BOX));
      const shortRowBox = await boxOf(rows.nth(0).locator(ROW_BOX));

      expect(
        wrappedRowBox.height,
        "a row carrying a wrapped name must be taller than a single-line row"
      ).toBeGreaterThan(shortRowBox.height);
      expect(
        wrappedRowBox.height,
        "a wrapped name must make its row grow past the old fixed row height"
      ).toBeGreaterThan(SINGLE_LINE_ROW_HEIGHT);
    });

    test("an indicator centres in its own row box, wrapped name or not", async ({
      page,
    }) => {
      // The wrapped case, plus the settled lifecycle row and an ordinary step
      // row as the controls: their one-line box has the same centre under
      // either composition.
      const rowWith = (rail: string, inner: string) =>
        page
          .locator(`${rail} ${ROW}`)
          .filter({ has: page.locator(inner) })
          .first();

      const cases = [
        {
          name: "wrapped step row",
          row: page.locator(`${WRAPPED_RAIL} ${ROW}`).nth(WRAPPED_ROW_INDEXES[0]),
          mustExceedOneLine: true,
        },
        {
          name: "single-line lifecycle row (control)",
          row: rowWith(SINGLE_LINE_RAIL, LIFECYCLE_ROW),
          mustExceedOneLine: false,
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
          // coincide and the case would prove nothing. Only the WRAPPED row
          // clears it; the two one-line rows beside it are the controls.
          expect(
            rowBoxHeight,
            `${name} must be taller than a single-line row box to be a real case`
          ).toBeGreaterThan(SINGLE_LINE_ROW_HEIGHT + EPSILON);
        }

        // `align-items: center` on the drawn row: the mark centres in the ROW
        // BOX, not on the title's first line. With the withdrawn first-line
        // composition restored on this fixture the wrapped row's mark lands
        // well above this centre; the one-line rows read the same either way,
        // which is what makes them controls.
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

    test("a name that fits grows its row by nothing at all", async ({ page }) => {
      const shortRow = page
        .locator(`${SINGLE_LINE_RAIL} ${ROW}`)
        .filter({ has: page.locator(LIFECYCLE_ROW) })
        .first();
      await expect(shortRow).toHaveCount(1);

      const nameBox = await boxOf(shortRow.locator(TITLE));
      // The fixture's contract: this name must NOT wrap, or the row is just
      // another copy of the wrapped case and proves nothing new.
      expect(
        nameBox.height,
        "the single-line fixture's name must occupy exactly one line box"
      ).toBeLessThanOrEqual(ONE_LINE);

      const shortRowBox = await boxOf(shortRow.locator(ROW_BOX));
      const wrappedRowBox = await boxOf(
        page.locator(`${WRAPPED_RAIL} ${ROW}`).nth(WRAPPED_ROW_INDEXES[0]).locator(ROW_BOX)
      );

      // A row whose name fits is the ordinary single-line row and nothing
      // wider — it must never fall BELOW the floor...
      expect(
        shortRowBox.height,
        "a single-line lifecycle row must keep the single-line row box"
      ).toBeCloseTo(SINGLE_LINE_ROW_HEIGHT, 0);
      // ...and it must stay strictly shorter than a row whose name wraps, i.e.
      // the row grew by ITS OWN content and not by a shared constant.
      expect(
        shortRowBox.height,
        "a single-line lifecycle row must be shorter than a wrapped one"
      ).toBeLessThan(wrappedRowBox.height);
    });

    test("rows whose name fits keep the row box they always had", async ({ page }) => {
      for (const rail of [WRAPPED_RAIL, SINGLE_LINE_RAIL, PLAIN_RAIL]) {
        const rows = page.locator(`${rail} ${ROW}`);
        const count = await rows.count();
        expect(count, `${rail} must render its rows`).toBeGreaterThan(0);

        let oneLineRows = 0;
        for (let i = 0; i < count; i += 1) {
          const row = rows.nth(i);
          const nameBox = await boxOf(row.locator(TITLE));
          // The claim is about rows whose name FITS. A wrapped row is the
          // subject of the claims above and is skipped here by measurement,
          // never by a hard-coded index.
          if (nameBox.height > ONE_LINE) continue;
          oneLineRows += 1;
          const box = await boxOf(row.locator(ROW_BOX));
          expect(
            box.height,
            `${rail} row ${i} must keep the single-line row box`
          ).toBeCloseTo(SINGLE_LINE_ROW_HEIGHT, 0);
        }
        expect(
          oneLineRows,
          `${rail} must carry at least one row whose name fits`
        ).toBeGreaterThan(0);
      }
    });
  });
}