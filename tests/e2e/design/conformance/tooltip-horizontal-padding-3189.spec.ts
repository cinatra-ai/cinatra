/**
 * specs/app-components.html#Tooltip / Popover (#3189): approved Tooltip example has padding 6px 10px and a 6px corner.
 * specs/app-components.html#Tooltip / Popover 0.6.0 (#4036): the shadow is set per palette — the light tooltip keeps
 * 0 4px 8px -2px rgba(21,33,58,0.3), the dark tooltip draws 0 4px 8px rgba(0,0,0,0.5).
 * Read the existing unoverridden gallery tooltip's real computed cascade in
 * both application palettes. No fixture, CSS, theme class or primitive is
 * substituted. Authoring does not claim a browser run or independent UI grade.
 */
import { expect, test } from "@playwright/test";

const PALETTES = [
  { name: "light", theme: "cinatra", shadow: "rgba(21, 33, 58, 0.3) 0px 4px 8px -2px" },
  { name: "dark", theme: "dark", shadow: "rgba(0, 0, 0, 0.5) 0px 4px 8px 0px" },
] as const;

// Tailwind composes box-shadow from five layers; the four it leaves unset compute to this transparent zero layer.
const UNSET_SHADOW_LAYER = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";

for (const palette of PALETTES) {
  test(`specs/app-components.html#Tooltip / Popover default padding, corners and shadow — ${palette.name}`, async ({ page }) => {
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
    const geometry = await content.evaluate((element) => {
      const style = getComputedStyle(element);
      return { left: style.paddingLeft, right: style.paddingRight,
        top: style.paddingTop, bottom: style.paddingBottom,
        topLeft: style.borderTopLeftRadius, topRight: style.borderTopRightRadius,
        bottomLeft: style.borderBottomLeftRadius, bottomRight: style.borderBottomRightRadius };
    });
    expect(geometry).toEqual({ left: "10px", right: "10px", top: "6px", bottom: "6px",
      topLeft: "6px", topRight: "6px", bottomLeft: "6px", bottomRight: "6px" });
    const shadow = await content.evaluate((element) => getComputedStyle(element).boxShadow);
    // Split on the commas between layers, never on the commas inside a colour.
    const drawn = shadow.split(/,(?![^(]*\))/).map((layer) => layer.trim()).filter((layer) => layer !== UNSET_SHADOW_LAYER);
    expect(drawn).toEqual([palette.shadow]);
  });
}
