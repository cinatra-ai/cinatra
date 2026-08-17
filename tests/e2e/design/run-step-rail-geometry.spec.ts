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
 * Four claims, at a desktop AND a narrow viewport. Each was checked against
 * pre-fix markup (the same rail with the row's `h-8` restored) so the suite is
 * known to FAIL without the fix rather than merely passing with it:
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
 *   4. UNCHANGED — ordinary rows with no reason still measure exactly the
 *      2rem row box they always had (the `min-h-8` floor), on both the mixed
 *      rail and the lifecycle-free control rail.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/run-step-rail";

const WRAPPED_RAIL = '[data-surface-id="run-step-rail-wrapped"]';
const PLAIN_RAIL = '[data-surface-id="run-step-rail-plain"]';

const ROW = '[data-slot="stepper-item"]';
const ROW_BOX = '[data-slot="stepper-trigger"]';
const REASON = "[data-rail-lifecycle-reason]";
const LIFECYCLE_ROW = '[data-rail-kind="lifecycleDecision"]';
const STEP_ROW = '[data-rail-kind="step"]';

/** The 2rem (`h-8`) row box every ordinary single-line rail row has always had. */
const SINGLE_LINE_ROW_HEIGHT = 32;

/** Sub-pixel slack: fractional layout values must not be read as an overlap. */
const EPSILON = 0.5;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "element must be laid out and visible").not.toBeNull();
  return box!;
}

/** The viewports the report names: the reported desktop, and a narrow width
 *  where the reason wraps to more lines still. */
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

    test("rows without a reason keep the row box they always had", async ({ page }) => {
      for (const rail of [WRAPPED_RAIL, PLAIN_RAIL]) {
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
