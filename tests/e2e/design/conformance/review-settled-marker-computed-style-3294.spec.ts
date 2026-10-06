/**
 * #3294: read the shipped settled marker's actual cascade and geometry.
 * The existing conformance route mounts the real props-only component; no
 * utility CSS, component replacement, theme class or drawing is supplied here.
 * Browser execution and the production review-surface proof are separate.
 */
import { expect, test, type Page } from "@playwright/test";

const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;
const OUTCOMES = ["approved", "rejected", "changes_requested"] as const;

async function open(page: Page, theme: string): Promise<void> {
  // Use the application's next-themes initialization, as primitive-wave-leg1
  // does. Forcing a class after hydration would bypass the real palette path.
  await page.addInitScript((value) => {
    window.localStorage.setItem("theme", value);
  }, theme);
  await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-review-settled-fixture]")).toHaveCount(3);
  await expect.poll(() => page.evaluate(
    (value) => document.documentElement.classList.contains(value)
      && document.documentElement.classList.contains(value === "dark" ? "cinatra" : "dark") === false,
    theme,
  )).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; });
}

for (const palette of PALETTES) {
  test.describe(`settled marker computed style — ${palette.name}`, () => {
    for (const outcome of OUTCOMES) {
      test(`${outcome} draws a left-aligned pill and sentence row`, async ({ page }) => {
        await open(page, palette.theme);
        const fixture = page.locator(`[data-review-settled-fixture="${outcome}"]`);
        const row = fixture.locator('[data-conformance-id="review-gate-settled"]');
        const pill = row.locator('[data-conformance-id="review-gate-settled-pill"]');
        const sentence = row.locator('[data-conformance-id="review-gate-settled-sentence"]');
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-review-outcome", outcome);
        await expect(pill).toHaveText("Continued");
        await expect(sentence).toHaveText("Decided on the revision above.");
        await expect(row.locator("button, a, svg")).toHaveCount(0);

        const reading = await row.evaluate((element) => {
          const pill = element.querySelector('[data-conformance-id="review-gate-settled-pill"]');
          const sentence = element.querySelector('[data-conformance-id="review-gate-settled-sentence"]');
          const dot = pill?.querySelector('[aria-hidden="true"]');
          const host = element.parentElement;
          if (!pill || !sentence || !dot || !host) throw new Error("Missing real settled-row parts");
          const style = getComputedStyle(element);
          const pillStyle = getComputedStyle(pill);
          const dotStyle = getComputedStyle(dot);
          const rect = (node: Element) => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top,
              width: box.width, height: box.height, middle: box.top + box.height / 2 };
          };
          return {
            display: style.display, wrap: style.flexWrap, align: style.alignItems,
            rowGap: style.rowGap, columnGap: style.columnGap,
            justify: style.justifyContent, textAlign: style.textAlign,
            inset: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
            order: Array.from(element.children, (child) => child.getAttribute("data-conformance-id")),
            pillDisplay: pillStyle.display,
            pillRadii: [pillStyle.borderTopLeftRadius, pillStyle.borderTopRightRadius,
              pillStyle.borderBottomLeftRadius, pillStyle.borderBottomRightRadius].map(Number.parseFloat),
            dotRadii: [dotStyle.borderTopLeftRadius, dotStyle.borderTopRightRadius,
              dotStyle.borderBottomLeftRadius, dotStyle.borderBottomRightRadius].map(Number.parseFloat),
            row: rect(element), host: rect(host), pill: rect(pill),
            sentence: rect(sentence), dot: rect(dot),
          };
        });

        expect(reading.order).toEqual(["review-gate-settled-pill", "review-gate-settled-sentence"]);
        expect(reading.display).toBe("flex");
        expect(reading.wrap).toBe("wrap");
        expect(reading.align).toBe("center");
        expect(reading.rowGap).toBe("8px");
        expect(reading.columnGap).toBe("8px");
        expect(["normal", "flex-start", "start"]).toContain(reading.justify);
        expect(["start", "left"]).toContain(reading.textAlign);
        expect(reading.pillDisplay).toBe("inline-flex");
        expect(reading.row.width).toBeGreaterThan(0);
        expect(reading.pill.height).toBeGreaterThan(0);
        expect(reading.sentence.height).toBeGreaterThan(0);
        // Check the rendered edges, not the presence of w-full/text-left.
        expect(Math.abs(reading.row.left - reading.host.left)).toBeLessThanOrEqual(0.75);
        expect(Math.abs(reading.row.right - reading.host.right)).toBeLessThanOrEqual(0.75);
        expect(Math.abs(reading.pill.left - reading.row.left - reading.inset)).toBeLessThanOrEqual(0.75);
        expect(Math.abs(reading.sentence.left - reading.pill.right - 8)).toBeLessThanOrEqual(0.75);
        expect(Math.abs(reading.pill.middle - reading.sentence.middle)).toBeLessThanOrEqual(0.75);
        for (const radius of reading.pillRadii) expect(radius).toBeGreaterThanOrEqual(reading.pill.height / 2);
        expect(reading.dot.width).toBe(7);
        expect(reading.dot.height).toBe(7);
        for (const radius of reading.dotRadii) expect(radius).toBeGreaterThanOrEqual(3.5);
      });
    }
  });
}
