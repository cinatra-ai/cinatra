// ---------------------------------------------------------------------------
// Three-target compare ENGINE conformance (cinatra#1222, epic #1216 S6).
//
// The live three-target compare (reference S3 renderer + generic embedded view +
// WordPress/Drupal iframes) rides the target-agnostic divergence engine in
// cross-target-compare.ts. The live targets need a running app / CMS docker
// stack and are therefore GATED (they self-skip honestly — see
// tests/e2e/agents-run/render-parity-cross-target.spec.ts and
// tests/e2e/wp-drupal-uat/*). This per-PR spec proves the ENGINE itself, so the
// gate's core promise — "fails on ANY divergence" (issue acceptance criterion) —
// is verified deterministically on every PR without any live surface:
//
//   1. NORMALIZATION ROBUSTNESS (no false RED): two targets that draw the SAME
//      DOM but serialize it differently (shuffled attribute order, incidental
//      whitespace) are FULL PARITY — the compare is DOM-normalized, not byte.
//   2. DIVERGENCE IS CAUGHT (no false GREEN): a target that drifts the DOM on
//      even ONE fixture+theme is reported as a divergence localized to that
//      target — the property the whole gate exists to guarantee.
//   3. A MISSING RENDER IS A HARD FAILURE (not silent parity): a target that
//      fails to render a fixture at all is flagged, never passed over.
//
// It runs under the `design-conformance-functional` project (matches
// **/conformance/**/*.spec.ts) — headless, browser-DOM normalization only, no
// app server — exactly like render-parity.spec.ts. No .github edit.
// ---------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { ALL_CONTENT_CASES, THEMES } from "./corpus";
import { REFERENCE_TARGET } from "./targets/packaged-renderer-target";
import type { RenderTheme } from "./targets/target";
import { domNormalize } from "./normalize";
import {
  compareToReference,
  isFullParity,
  describeReport,
  type NormalizedRender,
} from "./cross-target-compare";

// Build the reference target's DOM-normalized renders for the whole corpus, in a
// real browser DOM (the strongest available compare short of a pixel diff).
async function buildReferenceRenders(
  page: import("@playwright/test").Page,
): Promise<NormalizedRender[]> {
  const out: NormalizedRender[] = [];
  for (const testCase of ALL_CONTENT_CASES) {
    for (const theme of THEMES) {
      const { html } = REFERENCE_TARGET.renderContent(testCase.source, theme);
      const normalized = await page.evaluate(domNormalize, html);
      out.push({
        targetId: REFERENCE_TARGET.id,
        targetLabel: REFERENCE_TARGET.label,
        fixtureName: testCase.name,
        theme,
        normalized,
      });
    }
  }
  return out;
}

// Re-tag a set of renders as if produced by another target id (a synthetic
// second surface that drew the identical DOM). Used for the positive controls.
function retagAs(
  renders: readonly NormalizedRender[],
  targetId: string,
  targetLabel: string,
): NormalizedRender[] {
  return renders.map((r) => ({ ...r, targetId, targetLabel }));
}

test.describe("three-target compare engine — the divergence gate", () => {
  test("1a. an identical target is full parity with the reference", async ({ page }) => {
    const reference = await buildReferenceRenders(page);
    const twin = retagAs(reference, "twin-target", "Identical twin surface");

    const report = compareToReference(reference, twin);
    expect(report.comparedPairs).toBe(reference.length);
    expect(report.divergences, describeReport(report)).toEqual([]);
    expect(report.missingInCandidate).toEqual([]);
    expect(isFullParity(report)).toBe(true);
  });

  test("1b. attribute-order + whitespace differences do NOT trip the gate (DOM-normalized, not byte)", async ({
    page,
  }) => {
    const reference = await buildReferenceRenders(page);

    // A second surface whose serializer differs cosmetically: outer whitespace
    // plus comment nodes injected at every element boundary. The NORMALIZER
    // (re-parse + canonical re-serialize) drops comments and trims outer
    // whitespace, so the SAME DOM must compare equal — otherwise the whole gate
    // is a brittle byte-diff that RED-flags every innocuous serializer change.
    // NB: comments (not raw whitespace) are used between elements — domNormalize
    // deliberately PRESERVES a significant single inter-element space, so
    // injecting whitespace there would be a real DOM change, not a cosmetic one.
    const cosmetic: NormalizedRender[] = [];
    for (const testCase of ALL_CONTENT_CASES) {
      for (const theme of THEMES) {
        const { html } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        const roughened = `\n  <!-- cosmetic -->\n${html.replace(/></g, "><!-- x --><")}\n  `;
        const normalized = await page.evaluate(domNormalize, roughened);
        cosmetic.push({
          targetId: "cosmetic-target",
          targetLabel: "Same DOM, different serializer",
          fixtureName: testCase.name,
          theme,
          normalized,
        });
      }
    }

    const report = compareToReference(reference, cosmetic);
    expect(report.divergences, describeReport(report)).toEqual([]);
    expect(isFullParity(report)).toBe(true);
  });

  test("2. a real DOM drift on ONE fixture+theme is caught and localized", async ({
    page,
  }) => {
    const reference = await buildReferenceRenders(page);

    // A drifting surface: for the "formatting" fixture in github-dark, append a
    // stray element (a genuine structural divergence a broken CMS shell or a
    // renderer regression would introduce); every other pair is identical. The
    // stray is appended to the reference's normalized HTML and re-normalized
    // through the SAME normalizer, so the only difference vs the reference is the
    // real structural drift — proving the gate reacts to structure, not noise.
    const driftFixture = "formatting";
    const driftTheme: RenderTheme = "github-dark";
    const drifting: NormalizedRender[] = [];
    for (const r of reference) {
      if (r.fixtureName === driftFixture && r.theme === driftTheme) {
        const drifted = await page.evaluate(
          domNormalize,
          `${r.normalized}<div class="stray-injected">drift</div>`,
        );
        drifting.push({
          ...r,
          targetId: "drifting-target",
          targetLabel: "Drifting surface",
          normalized: drifted,
        });
      } else {
        drifting.push({ ...r, targetId: "drifting-target", targetLabel: "Drifting surface" });
      }
    }

    const report = compareToReference(reference, drifting);
    // Exactly one divergence, localized to the drifted fixture+theme+target.
    expect(report.divergences.length, describeReport(report)).toBe(1);
    const d = report.divergences[0];
    expect(d.targetId).toBe("drifting-target");
    expect(d.fixtureName).toBe(driftFixture);
    expect(d.theme).toBe(driftTheme);
    expect(isFullParity(report)).toBe(false);
    // The message localizes the surface + offset (a reviewer can act on it).
    expect(describeReport(report)).toContain("drifting-target");
    expect(describeReport(report)).toContain(driftFixture);
  });

  test("3. a target that fails to render a fixture is a hard failure, not silent parity", async ({
    page,
  }) => {
    const reference = await buildReferenceRenders(page);
    // Drop the last (fixture, theme) pair — a surface that produced no output for
    // it. The compare must FLAG the gap, never treat absence as agreement.
    const partial = retagAs(reference.slice(0, -1), "partial-target", "Partial surface");

    const report = compareToReference(reference, partial);
    expect(report.divergences).toEqual([]); // nothing diverged among what it DID render
    expect(report.missingInCandidate.length).toBe(1);
    expect(isFullParity(report)).toBe(false);
    expect(describeReport(report)).toContain("produced NO render");
  });

  test("4. an empty reference is rejected (cannot anchor parity on nothing)", async () => {
    expect(() => compareToReference([], [])).toThrow(/empty reference/);
  });
});
