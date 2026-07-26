// ---------------------------------------------------------------------------
// CMS-iframe render-parity leg (target 3) — cinatra#1998 (c), epic #1216 S6.
//
// The epic's headline promise is that the SAME assistant renders IDENTICALLY at
// `/chat`, inside the generic Cinatra embed, and inside the WordPress/Drupal
// admin iframe. Targets 1 (`/chat`) and 2 (generic embed) live on the agents-run
// suite; this is target 3 — the one #1216's verifier recorded as the residual
// "renders identically from /chat and a CMS embed" with NO live comparison. It
// frames the SAME `/embed/assistant` INSIDE the LIVE WordPress / Drupal admin
// (through the REAL plugin's launcher → required-login → sandboxed cross-origin
// `<iframe class="cw-frame">` bootstrap — `openWidget`), renders the 11-fixture
// corpus through the deterministic (b) corpus-render SEAM, and DOM-normalizes /
// compares each rendered content block against the S3 packaged-renderer reference
// — the SAME reference the committed goldens and target 1 are anchored to.
//
// ONE FRESH DOCUMENT PER FIXTURE — the plugin's proven normal page-load path.
// Rendering the next fixture needs a NEW embed iframe (a new `parityThread` src +
// a fresh single-use bridge nonce), and the LIVE plugin (wordpress-plugin
// `assets/cinatra-widget.js` @ current main, drupal-module `js/cinatra-widget.js`
// @ current main) mounts that iframe EXACTLY ONCE per document: `mountBridgeIframe`
// is guarded `if (iframeEl) return` and is reached ONLY from `enterConversation`,
// itself reached ONLY from `redeemCode` right after a hosted-login handshake. The
// launcher circle / close-button `collapseWidget` merely toggles
// `cwWidget.style.display` — it NEVER tears the iframe down (only `forceReLogin`
// does, via `teardownBridge`, and that drops the token too), and re-opening just
// un-hides the SAME already-bootstrapped frame. So there is NO in-session re-mount
// affordance: a held `cwu_` cannot be re-used to mount a second frame. The only
// paths to a fresh iframe are a full document reload or a re-login — both re-drive
// the hosted-login handshake (the `cwu_`/`cit_` tokens are in-memory only,
// dropped on navigation). An earlier form of this leg tried collapse→re-open to
// re-mount within one session; grounding against the real plugin (cinatra#1998
// issuecomment) disproved it — the launcher toggle never produced a second
// `/embed/assistant` mount and the click hung unbounded. So each fixture reloads
// the CMS host page, re-stages its seam, and re-drives the launcher → required-
// login → sandboxed cross-origin `<iframe class="cw-frame">` bootstrap (the exact
// path fixture 0 already proved live). That reload DOES re-charge the connect-
// token limiter (connect-rate-limit.ts), which has TWO buckets. The BINDING one is
// the per-code-key bucket: `/widget-auth/init` keys it on the FIXED per-CMS site
// credential hash, so all 22 reloads share ONE bucket capped at 5/min — the
// tightest limit (the 30/min per-IP bucket is slacker: `/widget-auth/token` keys
// its code bucket on the unique per-login PKCE code, never binding). The limiter
// is the real security control and is left UNTOUCHED; instead the leg PACES fixture
// starts (MIN_FIXTURE_INTERVAL_MS ≥ 15s ⇒ ≤4 inits/min, under 5, with the 30/min
// IP bucket well clear too), so reload-per-fixture never triggers the 429 storm a
// prior form produced. (We never re-`goto` the embed frame in place: the parent
// bootstrap is bound to a single-use nonce, so a bare embed reload's READY is
// ignored by design — bridge-protocol.ts.)
//
// HOW THE CORPUS REACHES THE CMS IFRAME (the three moving parts, all landed):
//   (a) Lane A — `/api/assistants/chat/capabilities` advertises `token-broker`
//       and serves the sessionless broker-auth embed, so the embed's client-side
//       negotiation reaches `ok` and mounts the renderer (cinatra#1998 (a)).
//   (b) The deterministic SEAM — with the server-only `EMBED_PARITY_SEAM` gate on,
//       the embed renders a seeded thread's assistant message through its OWN
//       mounted renderer (S3 `renderMarkdown`) IN PLACE OF a live LLM turn, into
//       the stable `[data-embed-content]` block, keyed off `?parityThread=` /
//       `?parityTheme=` (cinatra#1998 (b)).
//   (c) The plugin TEST-ONLY route-rewrite — the CMS widget's iframe `src` is
//       hardcoded to `instanceId`+`assistant`; the plugin now appends the seam
//       params when a test stages the STORAGE-FREE `window.__cinatraParitySeam`
//       global (or the `cinatra_parity_*` query-param fallback) — never storage,
//       to honor the widget's token non-disclosure invariant (inert in prod — the
//       server ignores `parityThread` unless its gate is on; wordpress-plugin /
//       drupal-module #1998 (c)). This leg stages that global (stageSeamSignal).
//
// READ-ONLY RENDER LEG. This leg drives NO edit turn, so it is NOT the #1214
// no-direct-egress positive control — that assertion stays where it already is,
// fenced on the REAL `*_content_editor_run` edit turn in the existing WP/Drupal
// scenario 5 (a read-only render corpus cannot serve as the egress control).
//
// HONEST GATING. Gated behind the explicit opt-in `E2E_EMBED_PARITY_LIVE=1` on a
// live stack that also has `EMBED_PARITY_SEAM=1` and the docker WP/Drupal up with
// the seam-carrier plugin. Default (unset) → a LOUD, tracked skip naming the
// blocker. Enabled → the leg ENFORCES for real: every fixture MUST render and
// MUST match the reference, and a missing render is a hard failure (never silent
// parity). Not a per-PR check — like its agents-run siblings it needs the real
// authenticated app + persistence + the docker CMS stack.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type FrameLocator,
  type Page,
} from "@playwright/test";

import {
  ALL_CONTENT_CASES,
  THEMES,
} from "../design/conformance/render-parity/corpus";
import {
  canonicalizeCodeBlocks,
  domNormalize,
} from "../design/conformance/render-parity/normalize";
import { REFERENCE_TARGET } from "../design/conformance/render-parity/targets/packaged-renderer-target";
import {
  compareToReference,
  describeReport,
  isFullParity,
  type NormalizedRender,
} from "../design/conformance/render-parity/cross-target-compare";
import type { RenderTheme } from "../design/conformance/render-parity/targets/target";

import {
  DRUPAL_BASE,
  SEL,
  WP_BASE,
  loginDrupal,
  loginWordPress,
  openWidget,
  readSeed,
} from "./helpers";

/** Opt-in flag ENABLING the live CMS-iframe render-parity leg (target 3). Default
 *  (unset) → a loud, tracked skip. Shared name with the agents-run target-2 leg
 *  (render-parity-live-targets.ts) so ONE flip enables the whole three-target
 *  compare. cinatra#1216 S6 / #1222 / #1998. */
const EMBED_PARITY_LIVE_ENV = "E2E_EMBED_PARITY_LIVE";

/** The cinatra dev server the widget config points at (same value the suite's
 *  global-setup asserts into the CMS widget config). Threads are seeded here and
 *  the embed iframe (served from here) reads them back. */
const CINATRA_BASE =
  process.env.E2E_WP_DRUPAL_BASE_URL ??
  `http://localhost:${process.env.E2E_WP_DRUPAL_PORT ?? "3000"}`;

type Cms = "wordpress" | "drupal";

/**
 * Seed a thread whose sole assistant message IS the corpus fixture, via the same
 * first-class persistence route the chat client writes — owned by the UAT dev
 * user (the suite's storageState session), so the embed's same-site seam fetch
 * (`credentials: "include"`, localhost is one registrable site across ports) reads
 * it back. Returns the thread id.
 */
async function seedFixtureThread(
  request: APIRequestContext,
  source: string,
): Promise<string> {
  const threadId = randomUUID();
  const nowIso = new Date().toISOString();
  const seed = await request.post(`${CINATRA_BASE}/api/assistants/threads`, {
    data: {
      id: threadId,
      title: `render-parity ${threadId}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [
        { id: randomUUID(), role: "assistant", content: source, createdAt: nowIso },
      ],
    },
    headers: { "content-type": "application/json", Origin: CINATRA_BASE },
  });
  if (!seed.ok()) {
    throw new Error(
      `seeding /api/assistants/threads failed (${seed.status()} ${seed.statusText()}) — ` +
        `the CMS render-parity leg cannot drive an unseeded thread. Is the UAT dev ` +
        `session (storageState) valid against ${CINATRA_BASE}?`,
    );
  }
  return threadId;
}

/** DOM-normalize an HTML string exactly as the target-2 spec + the goldens do
 *  (canonicalize hydrated code blocks, then structural normalize) — both legs
 *  feed the SAME divergence engine. */
async function normalizeForCompare(page: Page, html: string): Promise<string> {
  const canonicalized = await page.evaluate(canonicalizeCodeBlocks, html);
  return page.evaluate(domNormalize, canonicalized);
}

/** The host admin page the CMS widget mounts on (the same page each CMS's
 *  scenario 3/4/5 drive `openWidget` from). */
function hostPageFor(cms: Cms, seed: ReturnType<typeof readSeed>): string {
  return cms === "wordpress"
    ? `${WP_BASE}${seed.wordpress.editUrl}` // wp-admin post editor
    : `${DRUPAL_BASE}${seed.drupal.viewUrl}`; // seeded node canonical view
}

async function loginFor(cms: Cms, page: Page): Promise<void> {
  if (cms === "wordpress") await loginWordPress(page);
  else await loginDrupal(page);
}

/**
 * Stage the plugin's TEST-ONLY seam signal on the host CMS page — a namespaced
 * `window.__cinatraParitySeam` global the plugin's `embedParitySeamParams` reads
 * at iframe-mount time. STORAGE-FREE by design: the widget's token
 * non-disclosure invariant (cinatra#411) forbids any localStorage/sessionStorage
 * reference, so the carrier is a plain global (it also survives the editor's own
 * history.replaceState URL rewrites, unlike a query param). MUST run AFTER
 * navigating the host page (so the window exists) and BEFORE `openWidget` mounts
 * the iframe (the plugin reads it during `enterConversation`). Never staged in
 * prod → the plugin src is byte-identical there.
 */
async function stageSeamSignal(
  page: Page,
  threadId: string,
  theme: RenderTheme,
): Promise<void> {
  await page.evaluate(
    ({ t, th }) => {
      (window as unknown as { __cinatraParitySeam?: unknown }).__cinatraParitySeam = {
        thread: t,
        theme: th,
      };
    },
    { t: threadId, th: theme },
  );
}

/**
 * Scrape the single `[data-embed-content]` block the seam rendered inside the
 * mounted embed iframe, after best-effort waiting for shiki hydration to settle
 * (only the `code` fixture has `[data-shiki-code]` placeholders). Asserts
 * exactly one content block so a render-path/selector drift fails loud rather
 * than silently comparing the wrong node.
 */
async function scrapeEmbedContent(
  frame: FrameLocator,
  fixtureName: string,
  cms: Cms,
): Promise<string> {
  const content = frame.locator(SEL.embedAssistant);
  await content.first().waitFor({ state: "attached", timeout: 30_000 });
  const count = await content.count();
  if (count !== 1) {
    throw new Error(
      `expected exactly 1 assistant content block for "${fixtureName}" in the ${cms} ` +
        `iframe, found ${count} — the seam render path or [data-embed-content] drifted`,
    );
  }
  // Best-effort: wait for shiki to hydrate so the code fixture's compare is not a
  // placeholder race. A placeholder shape is a valid compare input, so a timeout
  // just proceeds (mirrors the target-2 harness).
  await frame
    .locator("[data-shiki-code]")
    .first()
    .waitFor({ state: "detached", timeout: 8_000 })
    .catch(() => {});
  return content.first().innerHTML();
}

/**
 * Render one fixture through a FRESH document — the plugin's proven normal
 * page-load path (the exact flow fixture 0 verified live). Reloading the CMS host
 * page is the ONLY harness-reachable way to obtain a fresh embed iframe (a new
 * `parityThread` src + a fresh single-use bridge nonce): the live plugin mounts
 * its iframe exactly once per document (`mountBridgeIframe`'s `if (iframeEl)
 * return` guard, reached only from a post-login `enterConversation`), and
 * `collapseWidget` only hides the panel (`display:none`) — it never tears the
 * frame down, so a held `cwu_` can never be re-used to mount a second frame in the
 * same document.
 *
 * The seam MUST be staged AFTER the reload (so `window.__cinatraParitySeam` exists
 * on the fresh window) and BEFORE the login handshake drives `enterConversation`
 * (which reads it at iframe-mount time). The reload drops the in-memory
 * `cwu_`/`cit_`, so `openWidget` re-drives the real hosted-login → sandboxed
 * cross-origin `<iframe class="cw-frame">` bootstrap. Fails LOUD (openWidget's
 * bounded login/mount/`embedActive` waits) if the widget does not re-mount — never
 * a silent stale compare. We never `frame.goto` the embed in place: its bootstrap
 * is bound to a single-use nonce, so a bare embed reload's READY is ignored by
 * design (bridge-protocol.ts).
 */
async function renderFixtureFresh(
  page: Page,
  hostPage: string,
  threadId: string,
  theme: RenderTheme,
): Promise<FrameLocator> {
  // Fresh document = fresh plugin IIFE = fresh login gate = fresh iframe mount.
  await page.goto(hostPage, { waitUntil: "domcontentloaded" });
  // Stage THIS fixture's seam on the fresh window before login → enterConversation.
  await stageSeamSignal(page, threadId, theme);
  // Drive the REAL plugin launcher → required-login → cross-origin iframe bootstrap.
  return openWidget(page);
}

/**
 * Register the CMS-iframe render-parity spec for one CMS. Frames the SAME
 * `/embed/assistant` inside the live CMS admin, renders the 11-fixture corpus
 * (both themes) through the (b) seam, and asserts full DOM-normalized parity with
 * the S3 reference the goldens are anchored to.
 */
export function registerCmsRenderParitySpec(cms: Cms): void {
  const label =
    cms === "wordpress"
      ? "WordPress admin iframe"
      : "Drupal admin iframe";

  test.describe(`CMS-iframe render-parity (target 3) — ${label} vs the S3 reference`, () => {
    test(`the ${cms} admin iframe renders the corpus identically to the reference`, async ({
      page,
      request,
    }) => {
      test.skip(
        process.env[EMBED_PARITY_LIVE_ENV] !== "1",
        `${label}: gated OFF (set ${EMBED_PARITY_LIVE_ENV}=1 on a stack with EMBED_PARITY_SEAM=1 ` +
          `and the docker WP/Drupal up with the seam-carrier plugin to enable). Lane A ` +
          `token-broker capabilities (#1998 (a)) + the EMBED_PARITY_SEAM corpus-render seam ` +
          `(b) + the plugin route-rewrite (c) have landed; enabling this flag runs the real ` +
          `plugin bootstrap + per-fixture content-mount + DOM parity assertion, which fails ` +
          `LOUD on any drift. #1216 S6 / #1222 / #1998 (c).`,
      );

      // 11 fixtures × 2 themes, each rendered through a FRESH document + real
      // plugin login+bootstrap (renderFixtureFresh — the only way to a fresh embed
      // iframe/nonce, see its doc). Generous budget well beyond the suite's
      // per-test default (22 paced logins + live bootstraps).
      test.setTimeout(20 * 60 * 1000);

      const seed = readSeed();
      const hostPage = hostPageFor(cms, seed);
      await loginFor(cms, page);

      // Flatten fixtures × themes into one ordered render plan — each entry reloads
      // the CMS host page and drives a full plugin login+bootstrap for a fresh
      // embed iframe carrying that entry's seam.
      const plan: Array<{ testCase: (typeof ALL_CONTENT_CASES)[number]; theme: RenderTheme }> = [];
      for (const testCase of ALL_CONTENT_CASES) {
        for (const theme of THEMES) plan.push({ testCase, theme });
      }

      const reference: NormalizedRender[] = [];
      const candidate: NormalizedRender[] = [];

      // Each fresh-document render re-drives the hosted login. The BINDING rate
      // limit (connect-rate-limit.ts, UNTOUCHED) is the per-code-key bucket:
      // `/widget-auth/init` keys it on the FIXED per-CMS site credential, so every
      // reload shares ONE bucket capped at 5 inits/min — i.e. ≥ 12s between actual
      // init calls. Pace fixture starts at 15s (the marker is recorded BEFORE
      // seed+navigation+login, so the real init lands a few seconds later; 15s
      // markers keep actual inits comfortably ≥ 12s apart ⇒ ≤ 4/min, under 5, and
      // the 30/min per-IP bucket well clear). Only the residual gap is slept —
      // natural per-fixture work already spends part of the interval. This is the
      // honest reload-per-fixture pacing that avoids the 429 storm a prior form of
      // this leg produced (which the once-per-CMS collapse→resume attempt could not
      // fix because the plugin has no in-session re-mount — see renderFixtureFresh).
      const MIN_FIXTURE_INTERVAL_MS = 15_000;
      let previousFixtureStartMs = 0;

      for (let i = 0; i < plan.length; i += 1) {
        const { testCase, theme } = plan[i];

        // Reference: the S3 packaged renderer (sync, deterministic) — the exact
        // path /chat renders through and the goldens snapshot. (Pure CPU; no
        // rate-limited network, so it runs before the throttle below.)
        const { html: refHtml } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        reference.push({
          targetId: REFERENCE_TARGET.id,
          targetLabel: REFERENCE_TARGET.label,
          fixtureName: testCase.name,
          theme,
          normalized: await normalizeForCompare(page, refHtml),
        });

        // Throttle to honor the connect-token IP limiter before the next full
        // login. Sleep only the residual since the previous fixture's login start.
        if (previousFixtureStartMs > 0) {
          const elapsed = Date.now() - previousFixtureStartMs;
          if (elapsed < MIN_FIXTURE_INTERVAL_MS) {
            await page.waitForTimeout(MIN_FIXTURE_INTERVAL_MS - elapsed);
          }
        }
        previousFixtureStartMs = Date.now();

        // Candidate: seed the fixture as a thread, then render it through a fresh
        // document + real plugin login+bootstrap (fixture 0's proven live path).
        const threadId = await seedFixtureThread(request, testCase.source);
        const frame = await renderFixtureFresh(page, hostPage, threadId, theme);
        const liveHtml = await scrapeEmbedContent(frame, testCase.name, cms);
        candidate.push({
          targetId: `${cms}-iframe`,
          targetLabel: label,
          fixtureName: testCase.name,
          theme,
          normalized: await normalizeForCompare(page, liveHtml),
        });
      }

      const report = compareToReference(reference, candidate);
      expect(isFullParity(report), describeReport(report)).toBe(true);
    });
  });
}
