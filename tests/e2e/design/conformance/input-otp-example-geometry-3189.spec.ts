/**
 * #3189 approved example: six slots width40/height44, dash width10/height2.
 * Narrow computed/box controls on the existing unmodified leg2 fixture.
 * Authoring does not claim execution, pictures or an independent UI grade.
 */
import { expect, test } from "@playwright/test";

const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;

for (const palette of PALETTES) {
  test(`Input OTP example geometry — ${palette.name}`, async ({ page }) => {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("theme", theme);
    }, palette.theme);
    await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate((theme) =>
      document.documentElement.classList.contains(theme) &&
      !document.documentElement.classList.contains(theme === "dark" ? "cinatra" : "dark"),
    palette.theme)).toBe(true);
    await page.evaluate(async () => { await document.fonts.ready; });

    const fixture = page.locator('[data-wave-seam="input-otp"]');
    await expect(fixture).toHaveCount(1);
    const groups = fixture.locator('[data-slot="input-otp-group"]');
    await expect(groups).toHaveCount(2);
    const slots = fixture.locator('[data-slot="input-otp-slot"]');
    await expect(slots).toHaveCount(6);
    for (const slot of await slots.all()) {
      await expect(slot).toBeVisible();
      const geometry = await slot.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return { width: style.width, height: style.height,
          boxWidth: box.width, boxHeight: box.height };
      });
      expect(geometry).toEqual({ width: "40px", height: "44px", boxWidth: 40, boxHeight: 44 });
    }
    const separator = fixture.getByRole("separator");
    await expect(separator).toHaveCount(1);
    const dash = separator.locator('[data-slot="input-otp-separator-dash"]');
    await expect(dash).toHaveCount(1);
    await expect(dash).toBeVisible();
    const geometry = await dash.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { width: style.width, height: style.height,
        boxWidth: box.width, boxHeight: box.height };
    });
    expect(geometry).toEqual({ width: "10px", height: "2px", boxWidth: 10, boxHeight: 2 });
  });
}
