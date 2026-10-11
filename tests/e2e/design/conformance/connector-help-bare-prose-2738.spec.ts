/**
 * cinatra#2738 — design#201 d479167ad0016d97f44a4801a0ee1bb8ebfced58,
 * specs/app-connectors.html §II, Example — Help tab · bare prose at Narrow width.
 * APP898: schema advisories retain label headings and literal paragraphs; no
 * example-only unlabeled lead, markup parser or invented connector copy.
 * These are rendered CI pins, not screenshots or a local rendering claim.
 */
import { test, expect } from "@playwright/test";
import { ensureSeeded, SEEDED_HARNESS_PATH } from "./contract";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`§II design201 Help: bare labeled prose, ${theme}, viewport ${width}`, async ({ page }) => {
      await ensureSeeded();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
      const mount = page.locator('[data-surface-id="connector-setup-tabbed"][data-variant="populated"]');
      await expect(mount).toHaveCount(1);
      const tabs = mount.getByRole("tablist");
      const names = await tabs.getByRole("tab").allTextContents();
      expect(names.at(-1)).toBe("Help");
      await mount.getByRole("tab", { name: "Help", exact: true }).click();
      const prose = mount.getByTestId("help-prose");
      await expect(prose).toBeVisible();
      await expect(prose.locator('[data-slot="card"], [data-slot="card-content"], input, textarea, select, button, form, [role="switch"]')).toHaveCount(0);
      await expect(prose.getByRole("heading", { level: 3 })).toHaveText(["Connect the fixture", "About the local shell"]);
      await expect(prose.locator("p")).toHaveText([
        "Create a fixture key and paste it into the API key field on the Setup tab.",
        "The Local shell tab controls the fixture's sandbox policy.",
      ]);
      const readings = await prose.evaluate((body) => {
        const css = getComputedStyle(body);
        const rect = body.getBoundingClientRect();
        const row = body.closest('[data-slot="tabs"]')!.querySelector('[role="tablist"]')!.parentElement!;
        const rowRect = row.getBoundingClientRect();
        const resolve = (property: "color" | "fontFamily", value: string) => {
          const node = document.createElement("span");
          node.style[property] = value; document.body.append(node);
          const result = getComputedStyle(node)[property]; node.remove(); return result;
        };
        const sections = [...body.querySelectorAll('[data-testid="help-section"]')].map((section) => {
          const heading = section.querySelector("h3")!;
          const paragraph = section.querySelector("p")!;
          const h = getComputedStyle(heading), p = getComputedStyle(paragraph);
          return { heading: { size: h.fontSize, line: h.lineHeight, weight: h.fontWeight, family: h.fontFamily.split(",")[0], color: h.color }, paragraph: { size: p.fontSize, line: p.lineHeight, family: p.fontFamily.split(",")[0], color: p.color, margin: p.margin }, gap: paragraph.getBoundingClientRect().top - heading.getBoundingClientRect().bottom };
        });
        return { maxWidth: css.maxWidth, gap: css.rowGap, display: css.display, direction: css.flexDirection, background: css.backgroundColor, shadow: css.boxShadow, border: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth], padding: css.padding, leftDelta: rect.left - rowRect.left, belowTabs: rect.top - rowRect.bottom, width: rect.width, rowWidth: rowRect.width, sections, ink: resolve("color", "var(--ink)"), muted: resolve("color", "var(--muted)"), headingFamily: resolve("fontFamily", "var(--font-archivo)").split(",")[0], bodyFamily: resolve("fontFamily", "var(--font-inter)").split(",")[0] };
      });
      expect(readings.maxWidth).toBe("576px");
      expect(readings.width).toBeCloseTo(Math.min(576, readings.rowWidth), 0);
      expect(readings.leftDelta).toBeCloseTo(0, 1);
      expect(readings.belowTabs).toBeCloseTo(24, 1);
      expect(readings.gap).toBe("20px");
      expect(readings.display).toBe("flex"); expect(readings.direction).toBe("column");
      expect(readings.background).toBe("rgba(0, 0, 0, 0)"); expect(readings.shadow).toBe("none");
      expect(readings.border).toEqual(["0px", "0px", "0px", "0px"]); expect(readings.padding).toBe("0px");
      for (const section of readings.sections) {
        expect(section.heading).toEqual({ size: "14px", line: "20px", weight: "600", family: readings.headingFamily, color: readings.ink });
        expect(section.paragraph).toEqual({ size: "14px", line: "24px", family: readings.bodyFamily, color: readings.muted, margin: "0px" });
        expect(section.gap).toBeCloseTo(4, 1);
      }
    });
  }
}
