/** specs/app-components.html#Checkbox-Radio-Switch: control16–18px,
 * indigo when on, surface-muted when off. Actual computed readings of the
 * shipped gallery radios in both palettes; authoring is not a browser run.
 */
import { expect, test } from "@playwright/test";
import { waitForHydration } from "../../config/hydration";

for (const palette of [{ name: "light", theme: "cinatra" }, { name: "dark", theme: "dark" }] as const) {
  test(`specs/app-components.html#Checkbox-Radio-Switch: 16px circle, invariant indigo and off ground — ${palette.name}`, async ({ page }) => {
    await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), palette.theme);
    await page.goto("/design-fixtures", { waitUntil: "domcontentloaded" });
    await waitForHydration(page, { selectors: ['[data-slot="radio-group-item"]'] });
    await expect.poll(() => page.evaluate((theme) => document.documentElement.classList.contains(theme)
      && !document.documentElement.classList.contains(theme === "dark" ? "cinatra" : "dark"), palette.theme)).toBe(true);
    await page.evaluate(async () => { await document.fonts.ready; });
    const daily = page.getByRole("radio", { name: "Daily", exact: true });
    const live = page.getByRole("radio", { name: "Live", exact: true });
    await expect(daily).toHaveCount(1);
    await expect(live).toHaveCount(1);
    await expect(daily).toBeVisible();
    await expect(live).toBeVisible();
    await expect(daily).toBeChecked();
    await expect(live).not.toBeChecked();
    for (const radio of [daily, live]) {
      const geometry = await radio.evaluate((element) => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { width: box.width, height: box.height, corners: [style.borderTopLeftRadius,
          style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius] };
      });
      expect(geometry.width).toBe(16);
      expect(geometry.height).toBe(16);
      for (const radius of geometry.corners) expect(parseFloat(radius)).toBeGreaterThanOrEqual(8);
    }
    const dot = daily.locator('[data-slot="radio-group-indicator"] svg');
    await expect(dot).toHaveCount(1);
    expect(await dot.evaluate((element) => getComputedStyle(element).fill)).toBe("rgb(54, 78, 129)");
    expect(await daily.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(54, 78, 129)");
    await expect(live.locator('[data-slot="radio-group-indicator"]')).toHaveCount(0);
    const off = await live.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface-muted)";
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual: getComputedStyle(element).backgroundColor, expected };
    });
    expect(off.expected).not.toBe("rgba(0, 0, 0, 0)");
    expect(off.actual).toBe(off.expected);
  });
}
