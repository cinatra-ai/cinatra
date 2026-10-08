/**
 * #3189: approved Tooltip example has padding 6px 10px.
 * Read the existing unoverridden gallery tooltip's real computed cascade in
 * both application palettes. No fixture, CSS, theme class or primitive is
 * substituted. Authoring does not claim a browser run or independent UI grade.
 */
import { expect, test } from "@playwright/test";

const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;

for (const palette of PALETTES) {
  test(`default Tooltip padding — ${palette.name}`, async ({ page }) => {
    // Initialize next-themes as the maintained primitive conformance cases do.
    await page.addInitScript((theme) => {
      window.localStorage.setItem("theme", theme);
    }, palette.theme);
    await page.goto("/design-fixtures", { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate((theme) =>
      document.documentElement.classList.contains(theme) &&
      !document.documentElement.classList.contains(theme === "dark" ? "cinatra" : "dark"),
    palette.theme)).toBe(true);
    await page.evaluate(async () => { await document.fonts.ready; });

    const trigger = page.getByRole("button", { name: "Hover me", exact: true });
    await expect(trigger).toHaveCount(1);
    await trigger.hover();
    const content = page.locator('[data-slot="tooltip-content"]');
    await expect(content).toHaveCount(1);
    await expect(content).toBeVisible();
    await expect(content).toContainText("Tooltip — navy bg, cream text");
    await expect(content.locator('[data-slot="kbd"]')).toHaveCount(0);
    const padding = await content.evaluate((element) => {
      const style = getComputedStyle(element);
      return { left: style.paddingLeft, right: style.paddingRight,
        top: style.paddingTop, bottom: style.paddingBottom };
    });
    expect(padding).toEqual({ left: "10px", right: "10px", top: "6px", bottom: "6px" });
  });
}
