// ---------------------------------------------------------------------------
// Live `/chat` render-parity conformance (cinatra#1222, epic #1216 S6 — the
// LIVE-RUN slice S2 unblocked).
//
// Drives the REAL running `/chat` (target (1) of the three-target compare) and
// asserts every content/hostile fixture renders to the SAME DOM the static
// reference target (the S3 packaged renderer) locked as a golden — so "exactly
// like /chat" is proven on the running surface, not only against the renderer
// in isolation. This closes the S2-enabled half of the live run: it catches
// drift the static gate cannot see — a wrong content wrapper, a stray
// post-render transform, a sanitizer difference, a broken theme thread, or a
// regression in how chat-messages-view mounts `renderMarkdown`.
//
// GATED LIVE SPEC. Like its agents-run siblings (chat-mcp, chat-prompt-hitl)
// this needs the canonical long-lived schema + a real authenticated session +
// the running app, so it is NOT a per-PR gate — it runs on the stack via the
// e2e-app-suites workflow_dispatch path (its `chat-render-parity` project) or
// locally against the verify stack:
//
//   pnpm exec playwright test --config tests/e2e/config/agents-run.config.ts \
//     --project chat-render-parity
//
// The one piece of novel compare logic — the shiki-hydration reconciliation
// (`canonicalizeCodeBlocks`) — is verified SERVER-FREE in per-PR CI by
// tests/e2e/design/conformance/render-parity/render-parity-live-normalize.spec.ts.
//
// STILL GATED ON S5 (#1221) — reported, out of scope here: the generic embedded
// conversation-view + the WordPress/Drupal iframe targets (targets (2)/(3)) and
// their cross-target equality, and the #1214 no-direct-egress assertion inside
// that embedded E2E. STILL GATED ON S4 (#1220): the DOM/visual render-compare of
// the AG-UI interactive layer (tool-call chips, HITL, RUN_ERROR, change-diff) —
// the corpus schema-locks their wire fixtures today.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import {
  ALL_CONTENT_CASES,
  THEMES,
} from "../design/conformance/render-parity/corpus";
import {
  canonicalizeCodeBlocks,
  domNormalize,
} from "../design/conformance/render-parity/normalize";
import type { RenderTheme } from "../design/conformance/render-parity/targets/target";
import { createChatLiveTarget } from "./chat-render-parity-target";

const BASE_URL = process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000";

const CONTENT_GOLDEN_DIR = join(
  __dirname,
  "..",
  "design",
  "conformance",
  "render-parity",
  "__goldens__",
  "content",
);

function goldenPath(name: string, theme: RenderTheme): string {
  return join(CONTENT_GOLDEN_DIR, `${name}.${theme}.html`);
}

// The live-compare normalization: collapse the shiki code-block hydration
// boundary (symmetric on both sides), then canonical DOM-normalize. Identical to
// plain domNormalize for the ten code-free fixtures.
async function normalizeForCompare(
  page: import("@playwright/test").Page,
  html: string,
): Promise<string> {
  const canonicalized = await page.evaluate(canonicalizeCodeBlocks, html);
  return page.evaluate(domNormalize, canonicalized);
}

test.describe("live /chat render-parity — content DOM matches the S3 golden", () => {
  for (const testCase of ALL_CONTENT_CASES) {
    for (const theme of THEMES) {
      test(`${testCase.name} · ${theme}`, async ({ page, request }) => {
        const path = goldenPath(testCase.name, theme);
        test.skip(
          !existsSync(path),
          `no committed golden for ${testCase.name} (${theme})`,
        );

        const target = createChatLiveTarget({ page, request, baseUrl: BASE_URL });
        const { html } = await target.renderContent(testCase.source, theme);

        // Optional visual proof for the PR (opt-in so the gated run stays lean).
        if (process.env.RENDER_PARITY_LIVE_SHOTS) {
          await page
            .screenshot({
              path: join(
                __dirname,
                ".render-parity-shots",
                `chat-live-${testCase.name}-${theme}.png`,
              ),
              fullPage: true,
            })
            .catch(() => {});
        }

        const golden = readFileSync(path, "utf8");
        const normLive = await normalizeForCompare(page, html);
        const normGolden = await normalizeForCompare(page, golden);

        expect(
          normLive,
          `live /chat render-parity drift in "${testCase.name}" (${theme}) — the ` +
            `running surface's content DOM diverged from the S3 packaged-renderer ` +
            `golden. This is NOT a renderer bug the static gate would catch: it is ` +
            `how the LIVE /chat mounts the renderer (wrapper, theme thread, ` +
            `sanitization, post-render transforms). Covers: ${testCase.covers.join(", ")}`,
        ).toBe(normGolden);
      });
    }
  }
});
