/**
 * Page-header SECTION-RULE conformance gate (design/specs/app.html — "Page
 * header" + §Dividers).
 *
 * Connector setup pages repeatedly shipped the WRONG rule beneath the page
 * title — a grey UA `<hr>`, a single grey hairline, or a two-tone bevel —
 * because the rule was only ever eyeballed against the spec, never asserted.
 * This gate mounts the REAL shared chrome the setup pages compose
 * (`/design-fixtures/header-rule`: `PageHeader` divider + `TabsListRow`, both
 * → `<Separator major>` → `.divider-etched`) and asserts, on the
 * production-equivalent boot, that every rule paints the spec's TWO full-navy
 * (`--line-strong` #15213A) 1px lines with a 5px gap — binding to the navy the
 * canonical app.html reference rule resolves to, not a bare literal.
 *
 * A wrong rule (grey / single line / two-tone / invisible) fails HERE,
 * mechanically, before it can reach a review.
 */
import { test, expect, type Page } from "@playwright/test";

import { classifyEtchedRule, SPEC_NAVY, type RuleComputed } from "./etched-rule";

const FIXTURE = "/design-fixtures/header-rule";

/**
 * Land on the fixture IN one palette.
 *
 * The two palettes are EXCLUSIVE classes on the root element — `cinatra` and
 * `dark` — and `next-themes` owns that class: it writes the persisted theme
 * onto the root when it mounts. A test that merely ADDS `dark` beside the
 * mounted `cinatra` is overwritten the moment hydration lands, so it measures
 * the LIGHT palette while calling itself dark — which is why the dark-ink
 * assertion below could not fail whatever the token said. The theme is
 * therefore switched the way the pixel harness beside this one switches it,
 * and the way a reader switches it: the persisted `next-themes` key, then a
 * reload so the anti-flicker script settles the root class before paint — and
 * the root class is READ BACK, so a palette that did not take is a red here
 * rather than a silent pass.
 */
async function visitInTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
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

/** Pull the computed-style subset the predicate needs from a live element. */
async function ruleComputed(
  locator: import("@playwright/test").Locator,
): Promise<RuleComputed> {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el as Element);
    return {
      height: cs.height,
      backgroundImage: cs.backgroundImage,
      backgroundColor: cs.backgroundColor,
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      borderTopColor: cs.borderTopColor,
      borderBottomWidth: cs.borderBottomWidth,
      borderBottomStyle: cs.borderBottomStyle,
      borderBottomColor: cs.borderBottomColor,
    };
  });
}

test.describe("page-header section rule — app.html conformance", () => {
  test("the app.html spec-reference rule resolves --line-strong to full navy", async ({
    page,
  }) => {
    await page.goto(FIXTURE);
    const ref = page.getByTestId("spec-reference-rule");
    await expect(ref).toBeVisible();
    const cs = await ruleComputed(ref);
    // The canonical paint the whole gate binds to.
    expect(cs.borderTopColor, "spec --line-strong must be #15213A navy").toBe(
      SPEC_NAVY,
    );
    const verdict = classifyEtchedRule(cs, cs.borderTopColor);
    expect(verdict.ok, `spec reference rule: ${verdict.reason}`).toBe(true);
    expect(verdict.form).toBe("border-pair");
  });

  for (const { name, wrapper } of [
    { name: "PageHeader divider", wrapper: "fixture-page-header" },
    { name: "TabsListRow (under-header tab row)", wrapper: "fixture-tabs-row" },
  ]) {
    test(`${name} paints the spec etched paired-line, not grey/single/two-tone`, async ({
      page,
    }) => {
      await page.goto(FIXTURE);

      // Bind the assertion to the navy the canonical spec-reference rule
      // resolves to (not just the literal), so a token drift is caught too.
      const specNavy = await page
        .getByTestId("spec-reference-rule")
        .evaluate((el) => getComputedStyle(el as Element).borderTopColor);
      expect(specNavy).toBe(SPEC_NAVY);

      const rule = page
        .getByTestId(wrapper)
        .locator('[data-slot="separator"][data-major]');
      await expect(
        rule,
        `${name}: the shared chrome must render exactly one <Separator major> etched rule`,
      ).toHaveCount(1);

      const cs = await ruleComputed(rule);
      const verdict = classifyEtchedRule(cs, specNavy);

      expect(
        verdict.ok,
        `${name} renders a NON-CONFORMANT header rule — ${verdict.reason}. ` +
          `Spec (design/specs/app.html): two full-navy ${specNavy} 1px lines, ` +
          `5px gap; never a grey, single, or two-tone divider. Computed: ${JSON.stringify(cs)}`,
      ).toBe(true);
    });
  }
});

/**
 * POSITION (cinatra#3106). The assertions above pin the rule's colour and its
 * paired-line shape, and pinned nothing about WHERE it sits — which is how the
 * tab row's trailing rule came to float eleven pixels above the row baseline,
 * reading as a second horizontal mark over the active tab's underline instead
 * of continuing it. `TabsListRow` drops the plain list's own `border-b`, which
 * paints on the list's bottom edge, so its replacement rule has to close the
 * row on that same edge.
 */
test.describe("tab-row rule position — the rule closes the row on its baseline", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`the trailing rule sits on the tab row's baseline (${theme} theme)`, async ({
      page,
    }) => {
      await visitInTheme(page, theme);

      const row = page.getByTestId("fixture-tabs-row");
      const rule = row.locator('[data-slot="separator"][data-major]');
      const list = row.locator('[data-slot="tabs-list"]');
      const activeTab = row.locator('[data-slot="tabs-trigger"][data-state="active"]');

      await expect(rule).toBeVisible();
      const ruleBox = await rule.boundingBox();
      const listBox = await list.boundingBox();
      const tabBox = await activeTab.boundingBox();
      expect(ruleBox && listBox && tabBox, "the tab row must be laid out").toBeTruthy();

      const ruleBaseline = ruleBox!.y + ruleBox!.height;
      const rowBaseline = listBox!.y + listBox!.height;
      const tabBaseline = tabBox!.y + tabBox!.height;

      expect(
        Math.abs(ruleBaseline - rowBaseline),
        `the trailing rule ends at y=${ruleBaseline} while the tab row ends at ` +
          `y=${rowBaseline} — a visible step where the tabs end and the rule begins`,
      ).toBeLessThanOrEqual(1);

      expect(
        Math.abs(ruleBaseline - tabBaseline),
        `the trailing rule ends at y=${ruleBaseline} while the active tab's underline ` +
          `sits on y=${tabBaseline} — the two must read as one continuous line`,
      ).toBeLessThanOrEqual(1);
    });
  }
});

/**
 * BOTH PALETTES (cinatra#3142 acceptance 6). The assertions above pin the
 * rule's colour in the palette a review is written in — the light one — and its
 * position in both. Nothing pinned the INK in dark, which is how the rule came
 * to keep its light-palette navy there: `--line-strong` was never declared for
 * the dark palette, so the token cascaded in at `#15213a` and the paired band
 * measured grey 32 of 255 in BOTH themes on twelve frames, while the hairlines
 * beside it read 224 in light and 23 in dark.
 *
 * These assertions guard #3106's fix and the drawing's pairing while the ink
 * changes underneath them: the trailing rule stays the paired etched band — two
 * 1px lines with the drawing's 5px gap — painted in ONE ink that is the
 * palette's own, reaching the content gutter, in light and in dark.
 */
test.describe("tab-row rule — the paired etched band in both palettes", () => {
  /** The gradient's opaque colour stops, as the browser serializes them. */
  async function inkStops(
    locator: import("@playwright/test").Locator,
  ): Promise<string[]> {
    return locator.evaluate((el) => {
      const image = getComputedStyle(el as Element).backgroundImage;
      const stops =
        image.match(
          /(rgba?\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8})/g,
        ) ?? [];
      return stops.filter((stop) => !/,\s*0\s*\)$/.test(stop) && !/\/\s*0\s*\)$/.test(stop));
    });
  }

  const inkPerTheme: Record<string, string> = {};

  for (const theme of ["light", "dark"] as const) {
    test(`the trailing rule is the paired etched band in one palette ink (${theme} theme)`, async ({
      page,
    }) => {
      await visitInTheme(page, theme);

      const row = page.getByTestId("fixture-tabs-row");
      const rule = row.locator('[data-slot="separator"][data-major]');
      await expect(rule).toBeVisible();

      const stops = await inkStops(rule);
      expect(
        stops.length,
        `the ${theme} rule paints no opaque stops — it is invisible, not a rule`,
      ).toBeGreaterThan(0);
      expect(
        new Set(stops).size,
        `the ${theme} rule paints ${stops.join(", ")} — a two-tone bevel, not one ink`,
      ).toBe(1);

      const ink = stops[0];
      inkPerTheme[theme] = ink;

      const cs = await ruleComputed(rule);
      const verdict = classifyEtchedRule(cs, ink);
      expect(
        verdict.ok,
        `the ${theme} tab-row rule is no longer the paired etched band — ` +
          `${verdict.reason}. Spec: two 1px lines of one ink with a 5px gap. ` +
          `Computed: ${JSON.stringify(cs)}`,
      ).toBe(true);
      expect(verdict.form).toBe("gradient");

      if (theme === "light") {
        expect(
          ink,
          "the light palette's section rule must stay the drawing's full navy",
        ).toBe(SPEC_NAVY);
      } else {
        expect(
          ink,
          "the dark palette paints the section rule in the light palette's full " +
            "navy — the token is inherited, not declared, and the rule all but " +
            "vanishes on a dark ground",
        ).not.toBe(SPEC_NAVY);
        expect(ink).not.toBe(inkPerTheme.light);
      }
    });

    test(`the trailing rule reaches the content gutter (${theme} theme)`, async ({
      page,
    }) => {
      await visitInTheme(page, theme);

      const row = page.getByTestId("fixture-tabs-row");
      const rule = row.locator('[data-slot="separator"][data-major]');
      await expect(rule).toBeVisible();

      const ruleBox = await rule.boundingBox();
      const rowBox = await row.boundingBox();
      expect(ruleBox && rowBox, "the tab row must be laid out").toBeTruthy();

      const ruleRight = ruleBox!.x + ruleBox!.width;
      const rowRight = rowBox!.x + rowBox!.width;
      expect(
        Math.abs(ruleRight - rowRight),
        `the trailing rule ends at x=${ruleRight} while the content gutter is at ` +
          `x=${rowRight} — the rule stops short of the edge it is drawn to reach`,
      ).toBeLessThanOrEqual(1);
      expect(
        ruleBox!.width,
        "the trailing rule must span the room left of the last tab, not a sliver",
      ).toBeGreaterThan(0);
    });
  }
});
