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
import { test, expect } from "@playwright/test";

import { classifyEtchedRule, SPEC_NAVY, type RuleComputed } from "./etched-rule";

const FIXTURE = "/design-fixtures/header-rule";

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
      await page.goto(FIXTURE);
      await page.evaluate((t) => {
        document.documentElement.classList.toggle("dark", t === "dark");
      }, theme);

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
