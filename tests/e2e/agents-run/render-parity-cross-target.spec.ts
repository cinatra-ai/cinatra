// ---------------------------------------------------------------------------
// Live three-target render-parity compare (cinatra#1222, epic #1216 S6 — the
// LIVE-RUN slice).
//
// Drives the corpus through the generic embedded conversation-view (target 2)
// and asserts its content DOM equals the S3 packaged-renderer reference — the
// same reference the committed goldens and the live `/chat` target (target 1)
// are anchored to. This is the cross-target divergence gate the issue's
// "renders identically across /chat / embedded / CMS iframes" acceptance line
// asks for; it rides the target-agnostic engine (render-parity/cross-target-compare.ts,
// whose divergence-detection is proven per-PR in cross-target-compare.spec.ts).
//
// HONEST GATING. The generic embedded view is served at `/embed/assistant` (S5
// #1221 Lane B). #1848 merged the embed CORE inert ("library-only, no route");
// the route lands with the embed page slice. Until the surface actually serves
// the content block, `probe()` reports it unavailable and this spec SKIPS with
// that exact reason — a documented follow-up, never a silent pass. The moment
// the route is live, this leg enforces with no code change.
//
// The CMS iframe target (target 3) additionally needs the docker WP/Drupal +
// wayflow compose profile (host port 3010) and the postMessage embed bridge; it
// is driven by the wp-drupal-uat suite path (which owns the CMS stack + the
// #1214 no-direct-egress assertion) once the embed page it frames is live.
//
// GATED LIVE SPEC (not per-PR) — like its agents-run siblings it needs the real
// authenticated app + persistence. Run against the verify stack:
//   pnpm exec playwright test -c tests/e2e/config/agents-run.config.ts \
//     --project render-parity-cross-target
// ---------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  ALL_CONTENT_CASES,
  THEMES,
} from "../design/conformance/render-parity/corpus";
import {
  canonicalizeCodeBlocks,
  domNormalize,
} from "../design/conformance/render-parity/normalize";
import { REFERENCE_TARGET } from "../design/conformance/render-parity/targets/packaged-renderer-target";
import type { RenderTheme } from "../design/conformance/render-parity/targets/target";
import {
  compareToReference,
  describeReport,
  isFullParity,
  type NormalizedRender,
} from "../design/conformance/render-parity/cross-target-compare";
import { createEmbeddedViewTarget } from "./render-parity-live-targets";

const BASE_URL = process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000";

async function normalizeForCompare(
  page: import("@playwright/test").Page,
  html: string,
): Promise<string> {
  const canonicalized = await page.evaluate(canonicalizeCodeBlocks, html);
  return page.evaluate(domNormalize, canonicalized);
}

test.describe("live three-target render-parity — embedded view vs the S3 reference", () => {
  test("the generic embedded conversation-view renders the corpus identically to the reference", async ({
    page,
    request,
  }) => {
    const embedded = createEmbeddedViewTarget({ page, request, baseUrl: BASE_URL });

    const probe = await embedded.probe();
    test.skip(
      !probe.available,
      probe.available ? "" : `embedded-view target unavailable — ${probe.reason}`,
    );

    // Build the reference + embedded normalized renders over the whole corpus,
    // then run the same divergence engine the per-PR spec proves.
    const reference: NormalizedRender[] = [];
    const candidate: NormalizedRender[] = [];
    for (const testCase of ALL_CONTENT_CASES) {
      for (const theme of THEMES) {
        const { html: refHtml } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        reference.push({
          targetId: REFERENCE_TARGET.id,
          targetLabel: REFERENCE_TARGET.label,
          fixtureName: testCase.name,
          theme,
          normalized: await normalizeForCompare(page, refHtml),
        });

        const { html: liveHtml } = await embedded.target.renderContent(
          testCase.source,
          theme,
        );
        candidate.push({
          targetId: embedded.target.id,
          targetLabel: embedded.target.label,
          fixtureName: testCase.name,
          theme,
          normalized: await normalizeForCompare(page, liveHtml),
        });
      }
    }

    const report = compareToReference(reference, candidate);
    expect(isFullParity(report), describeReport(report)).toBe(true);
  });
});
