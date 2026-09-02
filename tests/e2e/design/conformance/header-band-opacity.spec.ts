/**
 * THE HEADER BAND IS OPAQUE OVER SCROLLED CONTENT (cinatra#3142 §3, acceptance 7).
 *
 * The drawing, of the application shell: "The top-bar is chrome, not content",
 * and the palette gives chrome its own opaque grounds rather than a see-through
 * band. Drawn `bg-background/90 backdrop-blur-xl`, the shell's sticky header
 * composited ten per cent of whatever scrolled beneath it into the band by
 * construction and blurred the remainder rather than removing it — so on every
 * scrolled run-page frame the page's own agent-name line was drawn ghosted
 * inside the band, overlapping the breadcrumb row that lives there.
 *
 * The stacking was never the fault: the band sits above the page content, which
 * is why the text read as BEHIND it. It was the alpha. So this gate is about
 * alpha, and it MEASURES THE BAND rather than reading a class list — a fix that
 * only raised the stacking order does not pass it, and neither does one that
 * renames the utility while keeping the transparency.
 *
 * Two readings, on the real boot, in both palettes:
 *
 *   1. The band's own computed ground is alpha 1 and carries no backdrop
 *      filter.
 *   2. The band's PIXELS are identical with a loud known content string
 *      scrolled under it and with bare page ground scrolled under it. A band
 *      that lets any fraction of the page through cannot render the same in
 *      both states.
 */
import { test, expect, type Page } from "@playwright/test";

import { alphaOf } from "./computed-color";

const FIXTURE = "/design-fixtures/header-band-opacity";

/**
 * Switch the palette the way a reader switches it, and the way the pixel
 * harness beside this one switches it.
 *
 * The two palettes are EXCLUSIVE classes on the root element -- `cinatra` and
 * `dark` -- and `next-themes` owns that class: it writes the persisted theme
 * onto the root when it mounts. A helper that merely ADDS `dark` beside the
 * mounted `cinatra` is overwritten the moment hydration lands, so it measures
 * the LIGHT palette in both passes while calling one of them dark -- and the
 * dark half of every claim below could not fail whatever the token said. So
 * the theme is persisted and the page reloaded, letting the anti-flicker
 * script settle the root class before paint, and the root class is READ BACK:
 * a palette that did not take is a red here rather than a silent pass.
 */
async function visitInTheme(
  page: Page,
  theme: "light" | "dark",
  url: string = FIXTURE,
): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    window.localStorage.setItem("theme", t === "dark" ? "dark" : "cinatra");
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  const root = await page.evaluate(() => document.documentElement.className);
  expect(
    root.split(/\s+/),
    `the root carries "${root}" rather than the ${theme} palette's own class`,
  ).toContain(theme === "dark" ? "dark" : "cinatra");
}

/** The page-coordinate top of a fixture element. */
async function pageTop(page: Page, testId: string): Promise<number> {
  return page
    .getByTestId(testId)
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((to) => window.scrollTo(0, to), Math.round(y));
  await page.waitForFunction(
    (to) => Math.abs(window.scrollY - to) <= 1,
    Math.round(y),
  );
  // Let the sticky band settle at its scrolled state (its shadow is a
  // scroll-driven class, and both readings below are taken well past its
  // threshold so the two states differ ONLY in what is beneath the band).
  await page.waitForTimeout(150);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the shell's sticky header band — ${theme} theme`, () => {
    test("its computed ground is fully opaque and carries no backdrop filter", async ({
      page,
    }) => {
      await visitInTheme(page, theme);

      const band = page.getByTestId("app-shell-topbar");
      await expect(band).toBeVisible();

      const paint = await band.evaluate((el) => {
        const cs = getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          backdropFilter:
            cs.backdropFilter ||
            (cs as unknown as { webkitBackdropFilter?: string })
              .webkitBackdropFilter ||
            "none",
        };
      });

      const alpha = alphaOf(paint.backgroundColor);
      expect(
        alpha,
        `the band's ground computes to ${paint.backgroundColor}, whose alpha this ` +
          "gate could not read — an unreadable alpha is not a passing one",
      ).not.toBeNull();
      expect(
        alpha,
        `the band's ground computes to ${paint.backgroundColor} — chrome takes an ` +
          "opaque ground, and any alpha below 1 composites the scrolled page into it",
      ).toBe(1);
      expect(
        paint.backdropFilter,
        `the band carries backdrop-filter: ${paint.backdropFilter} — over an opaque ` +
          "ground it draws nothing, and over a translucent one it IS the frosted bleed",
      ).toBe("none");
    });

    test("a known content string scrolled under the band changes none of its pixels", async ({
      page,
    }) => {
      await visitInTheme(page, theme);

      const band = page.getByTestId("app-shell-topbar");
      await expect(band).toBeVisible();
      const bandBox = await band.boundingBox();
      expect(bandBox, "the shell header must be laid out").not.toBeNull();
      const bandHeight = bandBox!.height;

      // Reading A — bare page ground beneath the band, well past the band's own
      // scrolled-shadow threshold.
      const blankTop = await pageTop(page, "fixture-blank-run");
      await scrollTo(page, blankTop + 400);
      const overBlank = await band.screenshot();

      // Reading B — the known string beneath the band, the same band, the same
      // scrolled state, only the content under it changed.
      const probeTop = await pageTop(page, "fixture-probe");
      await scrollTo(page, probeTop - bandHeight / 3);
      const overProbe = await band.screenshot();

      // Prove the probe really is under the band, so a passing comparison
      // cannot be the trivial one.
      const covered = await page.getByTestId("fixture-probe").evaluate(
        (el, h) => {
          const r = el.getBoundingClientRect();
          return r.top < h && r.bottom > 0;
        },
        bandHeight,
      );
      expect(
        covered,
        "the fixture did not scroll its known string under the band — the " +
          "comparison below would prove nothing",
      ).toBe(true);

      expect(
        Buffer.compare(overBlank, overProbe),
        "the header band renders differently with page content beneath it than " +
          "with bare ground beneath it — the page is being composited into the " +
          "chrome, which is the ghost photographed across the breadcrumb row",
      ).toBe(0);
    });
  });
}
