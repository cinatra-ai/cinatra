/**
 * cinatra#3189: specs/app-components.html#Dialog: the approved inner Dialog example uses 8px corners.
 * Read the unchanged catalog dialog in each app palette after opening it.
 */
import { expect, test } from "@playwright/test";

for (const palette of ["cinatra", "dark"] as const) {
  test(`specs/app-components.html#Dialog default corners stay 8px in ${palette}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), palette);
    await page.goto("/design-fixtures");
    await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${palette}(?:\\s|$)`));
    const trigger = page.getByRole("button", { name: "Open dialog", exact: true });
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(trigger).toBeVisible();
    // Retry hydration-sensitive opening only while the actual dialog is absent.
    await expect(async () => {
      if (!(await dialog.isVisible())) await trigger.click();
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000, intervals: [100, 250, 500, 1_000] });
    await expect(dialog.getByRole("heading", { name: "Approve drafts", exact: true })).toBeVisible();
    for (const corner of ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]) {
      await expect(dialog).toHaveCSS(corner, "8px");
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  });
}
