/**
 * Partial host Switch reading for cinatra#3189, approved components831/93ac:
 * the actual example has a 32×18 track, a 14×14 thumb and 2px outer inset.
 * Authored browser Source, UNEXECUTED by this preparation lane. App-owned
 * approved governing surface and actual independent both-palette grade owed.
 *
 * pnpm exec playwright test -c tests/e2e/config/design.config.ts
 *   --project design-conformance-functional tests/e2e/design/conformance/switch.spec.ts
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const seam = '[data-wave-seam="switch"]';
const control = (page: Page, state: "off" | "on") => page.locator(`${seam} [data-wave-state="${state}"]`);

async function open(page: Page, theme: "cinatra" | "dark", direction: "ltr" | "rtl") {
  await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), theme);
  await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
  await expect(page.locator(seam)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
  // Set only the direction of the existing real fixture's containing context.
  // No implementation class or CSS is injected into the Switch or its thumb.
  await page.locator(seam).evaluate((node, direction) => node.setAttribute("dir", direction), direction);
  await expect(page.locator(seam)).toHaveAttribute("dir", direction);
}

async function read(control: Locator) {
  return control.evaluate((node) => {
    const thumb = node.querySelector('[data-slot="switch-thumb"]');
    if (!(thumb instanceof HTMLElement)) throw new Error("The real Switch thumb is missing");
    const track = node.getBoundingClientRect();
    const knob = thumb.getBoundingClientRect();
    return {
      trackWidth: track.width, trackHeight: track.height,
      thumbWidth: knob.width, thumbHeight: knob.height,
      left: knob.left - track.left, right: track.right - knob.right,
      top: knob.top - track.top, bottom: track.bottom - knob.bottom,
      direction: getComputedStyle(node).direction,
    };
  });
}

async function expectGeometry(control: Locator, checked: boolean, direction: "ltr" | "rtl") {
  await expect(control).toHaveAttribute("aria-checked", String(checked));
  await expect(control.locator('[data-slot="switch-thumb"]')).toHaveAttribute("data-state", checked ? "checked" : "unchecked");
  // Poll the real rectangles so a still-running thumb transition cannot be
  // mistaken for its settled position. Both vertical and horizontal bounds
  // are read; comparing only thumb<=track would miss the exemplar discrepancy.
  await expect.poll(async () => {
    const box = await read(control);
    const values = [box.trackWidth - 32, box.trackHeight - 18, box.thumbWidth - 14, box.thumbHeight - 14,
      box.top - 2, box.bottom - 2,
      (checked === (direction === "ltr") ? box.right : box.left) - 2];
    return Math.max(...values.map(Math.abs));
  }).toBeLessThan(0.25);
  expect((await read(control)).direction).toBe(direction);
}

for (const theme of ["cinatra", "dark"] as const) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`Switch ${theme} ${direction}: real thumb size and insets in both states`, async ({ page }) => {
      await open(page, theme, direction);
      const off = control(page, "off");
      const on = control(page, "on");
      await expectGeometry(off, false, direction);
      await expectGeometry(on, true, direction);
      // Read the same real uncontrolled components after interaction as well,
      // so the alternate state is not only an initially mounted illustration.
      await off.click();
      await expectGeometry(off, true, direction);
      await on.click();
      await expectGeometry(on, false, direction);
    });
  }
}
