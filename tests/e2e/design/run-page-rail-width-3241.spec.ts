import { expect, test, type Locator, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/run-step-rail";
const HOSTS = [
  { id: "run-surface-rail-width-host", column: "[data-run-step-rail-column]" },
  { id: "orchestrator-rail-width-host", column: "[data-run-step-rail]" },
] as const;

async function openPalette(page: Page, theme: "cinatra" | "dark") {
  // Use the maintained next-themes persistence road, without injecting CSS.
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  await page.evaluate((value) => localStorage.setItem("theme", value), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

async function expectDrawnWidth(column: Locator) {
  await expect(column).toHaveCount(1);
  await expect(column).toBeVisible();
  const width = await column.evaluate((element) => ({
    computed: Number.parseFloat(getComputedStyle(element).width),
    rendered: element.getBoundingClientRect().width,
  }));
  expect(width.computed, "production column's computed width").toBeCloseTo(196, 1);
  expect(width.rendered, "production column's laid-out width").toBeCloseTo(196, 1);
}

async function expectHosts(page: Page, rows: number) {
  for (const { id, column } of HOSTS) {
    const host = page.getByTestId(id);
    await expect(host.locator('[data-rail-kind="step"]')).toHaveCount(rows);
    await expectDrawnWidth(host.locator(column));
  }
  // The real inner panel must fit the frame's own column too.
  await expectDrawnWidth(
    page.getByTestId(HOSTS[0].id).locator("[data-run-step-rail]"),
  );
}

for (const theme of ["cinatra", "dark"] as const) {
  test(`both real run rail columns keep 196px through fewer rows — ${theme}`, async ({ page }) => {
    await openPalette(page, theme);
    await expectHosts(page, 3);
    await page.getByRole("button", { name: "Show transient rails", exact: true }).click();
    await expectHosts(page, 1);
    await page.getByRole("button", { name: "Restore ordinary rails", exact: true }).click();
    await expectHosts(page, 3);
  });
}
