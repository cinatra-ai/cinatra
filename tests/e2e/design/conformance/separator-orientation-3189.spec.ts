/**
 * Horizontal Separator geometry on the unchanged /design-fixtures catalog.
 * Authored for cinatra#3189; running this requires an authorized product boot.
 * This fixture has no vertical Separator. Vertical selector binding is covered
 * by the native Radix/Tailwind test; vertical browser geometry remains owed.
 * Major-divider height and tablist/toolbar composition are outside this fix.
 */
import { expect, test } from "@playwright/test";

for (const palette of ["cinatra", "dark"] as const) {
  test(`specs/app-components.html — Separator: "1px low-alpha hairline for rows" matches its content column in ${palette}`, async ({ page }) => {
    await page.goto("/design-fixtures", { waitUntil: "domcontentloaded" });
    await page.evaluate((theme) => window.localStorage.setItem("theme", theme), palette);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${palette}(?:\\s|$)`));
    await page.evaluate(() => document.fonts.ready);

    const row = page.locator("div.grid").filter({ has: page.getByRole("heading", { name: "Separator", exact: true }) });
    const separators = row.locator('[data-slot="separator"]');
    await expect(separators).toHaveCount(2);
    const hairline = separators.first();
    await expect(hairline).toHaveAttribute("data-orientation", "horizontal");
    await expect(hairline).toBeVisible();
    const reading = await hairline.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const column = el.parentElement!.getBoundingClientRect();
      const colorProbe = document.createElement("div");
      colorProbe.style.backgroundColor = "var(--border)";
      el.parentElement!.appendChild(colorProbe);
      const borderColor = getComputedStyle(colorProbe).backgroundColor;
      colorProbe.remove();
      return {
        height: box.height,
        width: box.width,
        left: box.left,
        right: box.right,
        columnWidth: column.width,
        columnLeft: column.left,
        columnRight: column.right,
        backgroundColor: getComputedStyle(el).backgroundColor,
        borderColor,
      };
    });
    expect(reading.height).toBeCloseTo(1, 2);
    expect(reading.columnWidth).toBeGreaterThan(0);
    expect(reading.width).toBeCloseTo(reading.columnWidth, 2);
    expect(reading.left).toBeCloseTo(reading.columnLeft, 2);
    expect(reading.right).toBeCloseTo(reading.columnRight, 2);
    expect(reading.backgroundColor).toBe(reading.borderColor);
  });
}
