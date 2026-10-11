/**
 * specs/app-artifact-review.html#review-gate-blocked (VII) and
 * specs/app-lifecycle-cards.html (IV, No longer open): Refresh ends the body
 * paragraph, with the drawing's blue #364e81, resting underline and 3px offset.
 * Read the shipped props-only blocked panel on the existing conformance route.
 * No markup/CSS/transport substitution; no capture or stale-gate grade is
 * claimed by authoring these cases. Hosted execution and App proof remain owed.
 */
import { expect, test } from "@playwright/test";

const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;

for (const palette of PALETTES) {
  for (const variant of ["populated", "error"] as const) {
    test(`review-gate-blocked inline Refresh drawing — ${palette.name}, ${variant}`, async ({ page }) => {
      await page.addInitScript((theme) => {
        window.localStorage.setItem("theme", theme);
      }, palette.theme);
      await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
      await expect.poll(() => page.evaluate((theme) =>
        document.documentElement.classList.contains(theme) &&
        !document.documentElement.classList.contains(theme === "dark" ? "cinatra" : "dark"),
      palette.theme)).toBe(true);
      await page.evaluate(async () => { await document.fonts.ready; });

      const mount = page.locator(`[data-surface-id="review-gate-blocked"][data-variant="${variant}"]`);
      await expect(mount).toHaveCount(1);
      const panel = mount.locator('[data-conformance-id="review-gate-blocked"]');
      await expect(panel).toHaveCount(1);
      await expect(panel).toBeVisible();
      const refresh = panel.getByRole("button", { name: "Refresh", exact: true });
      await expect(refresh).toHaveCount(1);
      await expect(refresh).toBeVisible();
      await expect(refresh).toHaveAttribute("data-action", "refresh-gate -> live-gate");

      const reading = await refresh.evaluate((element) => {
        const body = element.parentElement;
        if (!(body instanceof HTMLParagraphElement)) throw new Error("Refresh must end the body paragraph");
        const text = body.firstChild;
        if (!(text instanceof Text) || !text.textContent?.trim()) throw new Error("The explanatory sentence is missing");
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = Array.from(range.getClientRects());
        const lastLine = lines.at(-1);
        if (!lastLine) throw new Error("The sentence has no rendered line box");
        const control = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          bodyText: body.textContent,
          endsTheParagraph: element === body.lastElementChild && element.nextSibling === null,
          sharesLastTextLine: control.top < lastLine.bottom && control.bottom > lastLine.top,
          color: style.color, display: style.display, verticalAlign: style.verticalAlign,
          decoration: style.textDecorationLine, offset: style.textUnderlineOffset,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          margins: [style.marginTop, style.marginBottom],
        };
      });
      expect(reading.bodyText).toBe("The gate was already decided or the run moved on. Refresh");
      expect(reading.endsTheParagraph).toBe(true);
      expect(reading.sharesLastTextLine).toBe(true);
      expect(reading.color).toBe("rgb(54, 78, 129)");
      expect(reading.display).toBe("inline");
      expect(reading.verticalAlign).toBe("baseline");
      expect(reading.decoration).toBe("underline");
      expect(reading.offset).toBe("3px");
      expect(reading.padding).toEqual(["0px", "0px", "0px", "0px"]);
      expect(reading.margins).toEqual(["0px", "0px"]);
    });
  }
}
