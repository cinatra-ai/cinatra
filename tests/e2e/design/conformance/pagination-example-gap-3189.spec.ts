import { expect, test } from "@playwright/test"

// Approved app-components §Pagination example: the inner flex row has gap: 4px.
// This browser check is authored for CI; native declaration guards do not prove
// the computed app cascade or painted layout in either palette.
for (const palette of ["cinatra", "dark"] as const) {
  test(`§Pagination example row has a 4px gap (${palette})`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), palette)
    await page.goto("/design-fixtures")
    await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${palette}(?:\\s|$)`))

    const pagination = page.getByRole("navigation", { name: "pagination", exact: true })
    await expect(pagination).toHaveCount(1)
    const content = pagination.locator('[data-slot="pagination-content"]')
    await expect(content).toBeVisible()
    await expect(content).toHaveCSS("column-gap", "4px")
    await expect(content).toHaveCSS("row-gap", "4px")
    await expect(pagination.getByRole("link", { name: "1", exact: true })).toHaveAttribute("aria-current", "page")
  })
}
