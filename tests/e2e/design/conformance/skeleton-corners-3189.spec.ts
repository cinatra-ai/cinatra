/**
 * cinatra#3189: app-components' Skeleton examples use 4px corners.
 * Read the actual catalog bar in each app palette without changing its fixture.
 * Native compilation is separate; this case grades the browser cascade.
 */
import { expect, test } from "@playwright/test";

for (const palette of ["cinatra", "dark"] as const) {
  test(`Skeleton default corners stay 4px in ${palette}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), palette);
    await page.goto("/design-fixtures");
    await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${palette}(?:\\s|$)`));
    const row = page.getByRole("heading", { name: "Skeleton + Spinner", exact: true }).locator("../..");
    const bar = row.locator('[data-slot="skeleton"]');
    await expect(bar).toHaveCount(1);
    await expect(bar).toBeVisible();
    for (const corner of ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]) {
      await expect(bar).toHaveCSS(corner, "4px");
    }
    // Existing catalog dimensions are supplied by the caller, not Skeleton.
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBe(128);
    expect(box!.height).toBe(24);
    await expect(bar).toHaveCSS("animation-name", "pulse");
  });
}
