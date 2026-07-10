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
