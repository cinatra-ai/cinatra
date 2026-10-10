/**
 * Partial host Avatar reading for cinatra#3189, approved components831/93ac:
 * four 36px exemplars with 8px corners, categorical grounds and italic 800.
 * Real existing fallback fixture only; no Image or group-counter browser
 * coverage is implied. Source authored UNEXECUTED; App actual image/caller
 * proof, governing surface and independent both-palette grade remain owed.
 *
 * pnpm exec playwright test -c tests/e2e/config/design.config.ts
 *   --project design-conformance-functional tests/e2e/design/conformance/avatar.spec.ts
 */
import { expect, test } from "@playwright/test";

for (const theme of ["cinatra", "dark"] as const) {
  test(`Avatar ${theme}: actual fallback and pseudo border share the approved 8px corners`, async ({ page }) => {
    await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), theme);
    await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
    const seam = page.locator('[data-wave-seam="avatar"]');
    await expect(seam).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
    for (const [size, pixels] of [["default", 36], ["lg", 40], ["sm", 24]] as const) {
      // sm24 remains an existing product extension, not a drawn size clause.
      const avatar = seam.locator(`[data-wave-size="${size}"]`);
      await expect(avatar).toHaveAttribute("data-slot", "avatar");
      const fallback = avatar.locator('[data-slot="avatar-fallback"]');
      await expect(fallback).toBeVisible();
      const reading = await avatar.evaluate((node) => {
        const fallback = node.querySelector('[data-slot="avatar-fallback"]');
        if (!(fallback instanceof HTMLElement)) throw new Error("The real Avatar fallback is missing");
        const corners = (style: CSSStyleDeclaration) => [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
        const rootStyle = getComputedStyle(node);
        const fallbackStyle = getComputedStyle(fallback);
        const afterStyle = getComputedStyle(node, "::after");
        const box = node.getBoundingClientRect();
        const inner = fallback.getBoundingClientRect();
        return {
          width: box.width, height: box.height, innerWidth: inner.width, innerHeight: inner.height,
          rootCorners: corners(rootStyle), fallbackCorners: corners(fallbackStyle), afterCorners: corners(afterStyle),
          afterContent: afterStyle.content, fontWeight: fallbackStyle.fontWeight, fontStyle: fallbackStyle.fontStyle,
          background: fallbackStyle.backgroundColor, color: fallbackStyle.color,
        };
      });
      for (const measured of [reading.width, reading.height, reading.innerWidth, reading.innerHeight]) expect(Math.abs(measured - pixels)).toBeLessThan(0.25);
      for (const corners of [reading.rootCorners, reading.fallbackCorners, reading.afterCorners]) expect(corners).toEqual(["8px", "8px", "8px", "8px"]);
      expect(reading.afterContent).not.toBe("none");
      expect(reading.fontWeight).toBe("800");
      expect(reading.fontStyle).toBe("italic");
      expect(reading.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(reading.color).not.toBe(reading.background);
    }
  });
}
