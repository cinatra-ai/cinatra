/**
 * Calendar family, partial cinatra#3189. Real browser Source, not locally executed.
 * Approved design@831df380/components93ac, Calendar / Date picker:
 * range start outlined, interior soft tint, selected end filled; mono weekday
 * heads; DatePicker inside the real Popover, with Input-styled trigger.
 * The first/second/third-click range contract is additive host behavior.
 *
 * pnpm exec playwright test -c tests/e2e/config/design.config.ts
 *   --project design-conformance-functional tests/e2e/design/conformance/calendar.spec.ts
 * The exact fixture leaf follows the existing development-only admission.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const harness = "/design-fixtures/conformance/calendar";
const fixture = (name: string) => `[data-calendar-fixture="${name}"]`;
const day = (scope: Locator, key: string) => scope.locator(`[data-slot="calendar-day"][data-day="${key}"]`);

async function style(target: Locator, property: string) {
  return target.evaluate((node, prop) => getComputedStyle(node).getPropertyValue(prop), property);
}
/** Resolve an expected token/expression in the measured element's palette scope.
 * Only the probe is styled; the actual primitive and its cascade remain intact. */
async function resolved(scope: Locator, property: "backgroundColor" | "color" | "fontFamily", expression: string) {
  return scope.evaluate((node, { property, expression }) => {
    const probe = document.createElement("span");
    probe.style[property] = expression;
    node.appendChild(probe);
    const result = getComputedStyle(probe)[property];
    probe.remove();
    return result;
  }, { property, expression });
}
async function open(page: Page, theme: "cinatra" | "dark") {
  await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), theme);
  await page.goto(harness, { waitUntil: "domcontentloaded" });
  await expect(page.locator(fixture("root"))).toHaveAttribute("data-hydrated", "true");
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
}

for (const theme of ["cinatra", "dark"] as const) {
  test.describe(`Calendar ${theme} palette`, () => {
    test("the approved range exemplar resolves its start, interior and selected end in the real cascade", async ({ page }) => {
      await open(page, theme);
      const range = page.locator(fixture("range"));
      const start = day(range, "2026-05-15");
      const end = day(range, "2026-05-18");
      await expect(start).toHaveAttribute("data-range-start", "");
      await expect(end).toHaveAttribute("data-range-end", "");
      const primary = await resolved(range, "backgroundColor", "var(--primary)");
      const tint = await resolved(range, "backgroundColor", "color-mix(in oklab, var(--primary) 12%, transparent)");
      expect(await style(start, "box-shadow")).toContain(await resolved(range, "color", "var(--primary)"));
      expect(await style(start, "background-color")).not.toBe(primary);
      for (const key of ["2026-05-16", "2026-05-17"]) {
        await expect(day(range, key)).toHaveAttribute("data-in-range", "");
        expect(await style(day(range, key), "background-color")).toBe(tint);
      }
      expect(await style(end, "background-color")).toBe(primary);
      const box = await end.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBe(box!.height);
      expect(parseFloat(await style(end, "border-radius"))).toBeGreaterThanOrEqual(box!.width / 2);
      const weekday = range.locator('[data-slot="calendar-weekday"]').first();
      expect(await style(weekday, "font-family")).toBe(await resolved(range, "fontFamily", "var(--font-mono)"));
      expect(await style(weekday, "text-transform")).toBe("uppercase");
      // The existing single-day reading still gives today its ring and the selected day its fill.
      const single = page.locator(fixture("single"));
      expect(await style(day(single, "2026-05-15"), "box-shadow")).toContain(await resolved(single, "color", "var(--primary)"));
      expect(await style(day(single, "2026-05-18"), "background-color")).toBe(primary);
    });

    test("controlled range clicks restart, sort endpoints and retain keyboard focus semantics", async ({ page }) => {
      await open(page, theme);
      const range = page.locator(fixture("range"));
      await day(range, "2026-05-21").click();
      await expect(day(range, "2026-05-21")).toHaveAttribute("data-range-start", "");
      await expect(range.locator("[data-range-end], [data-in-range]")).toHaveCount(0);
      await day(range, "2026-05-19").click();
      await expect(day(range, "2026-05-19")).toHaveAttribute("data-range-start", "");
      await expect(day(range, "2026-05-21")).toHaveAttribute("data-range-end", "");
      await expect(day(range, "2026-05-20")).toHaveAttribute("data-in-range", "");
      await expect(range.locator('[data-slot="calendar-day"][tabindex="0"]')).toHaveCount(1);
      await day(range, "2026-05-31").focus();
      await day(range, "2026-05-31").press("ArrowRight");
      await expect(day(range, "2026-06-01")).toBeFocused();
    });

    test("the actual Popover stays open for a range start, closes on completion, and single mode keeps its close", async ({ page }) => {
      await open(page, theme);
      const trigger = page.locator(`${fixture("range-picker")} [data-slot="date-picker-trigger"]`);
      const reference = page.locator(`${fixture("input")} [data-slot="input"]`);
      for (const property of ["height", "border-radius", "border-top-width", "border-top-color", "background-color"]) {
        expect(await style(trigger, property)).toBe(await style(reference, property));
      }
      await trigger.click();
      const popover = page.locator('[data-slot="popover-content"]');
      await expect(popover).toBeVisible();
      expect(await style(popover, "background-color")).toBe(await resolved(popover, "backgroundColor", "var(--popover)"));
      await day(popover, "2026-05-15").click();
      await expect(popover).toBeVisible();
      await day(popover, "2026-05-18").click();
      await expect(popover).toHaveCount(0);
      await expect(trigger).toContainText("May 15, 2026 – May 18, 2026");
      const singleTrigger = page.locator(`${fixture("single-picker")} [data-slot="date-picker-trigger"]`);
      await singleTrigger.click();
      await day(page.locator('[data-slot="popover-content"]'), "2026-05-21").click();
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
      await expect(singleTrigger).toContainText("May 21, 2026");
    });
  });
}
