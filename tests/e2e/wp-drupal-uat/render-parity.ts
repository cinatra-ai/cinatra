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
// ONE SESSION FOR THE WHOLE CORPUS (cinatra#1998 (c) fix). The plugin login +
// iframe bootstrap runs ONCE; every fixture after the first re-mounts the widget
// iframe WITHIN that session — collapse the panel → stage the next seam → re-open
// (renderNextFixtureInSession) — reusing the session's held `cwu_` (a fresh
// short-lived `cit_` is minted per mount) with no new login. A prior form
// re-loaded the whole CMS host page per fixture, which
// dropped the in-memory `cwu_` and forced a fresh hosted login each time — 22
// `POST /api/widget-auth/init` per CMS that (correctly) exhausted the shared
// 30/min IP limiter (connect-rate-limit.ts). The limiter is the real security
// control and is left untouched; only the harness's wasteful per-fixture
// re-login is removed, matching how a real visitor's session persists across
// successive conversations. (Re-mount is a fresh plugin conversation-entry, NOT
// an in-place embed reload: the parent bootstrap is bound to a single-use bridge
// nonce, so a bare reload's READY is ignored by design — bridge-protocol.ts.)
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
//       params when a test stages a `cinatra_parity_*` sessionStorage signal
//       (inert in prod — the server ignores `parityThread` unless its gate is on;
//       wordpress-plugin / drupal-module #1998 (c)). This leg stages that signal.
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
  collapseWidget,
  loginDrupal,
  loginWordPress,
  openWidget,
  readSeed,
  resumeWidget,
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
 * Render the NEXT fixture in the SAME authenticated widget session — WITHOUT a
 * per-fixture re-login. Rather than reloading the whole CMS host page (which
 * drops the in-memory `cwu_` and forces a fresh hosted-login handshake — the
 * `POST /api/widget-auth/init` per fixture that exhausts the correct 30/min IP
 * limiter, cinatra#1998 (c)), we collapse the assistant panel and re-open it: the
 * plugin tears the conversation iframe down and re-enters conversation, mounting
 * a FRESH iframe (with a fresh single-use bridge nonce) that reads the just-staged
 * seam signal — reusing the session's held `cwu_` (a fresh `cit_` per mount)
 * with no new login.
 *
 * WHY collapse→resume AND NOT an in-place `frame.goto` reload of the embed: the
 * parent→iframe bootstrap is bound to the frame's single-use nonce gate
 * (bridge-protocol.ts) — BY DESIGN "a replacement document cannot re-open the
 * handshake", so a bare reload's READY is ignored (a downgrade defense) and the
 * embed would hang pre-bootstrap. Only a fresh plugin conversation-entry arms a
 * new gate. This mirrors a real visitor collapsing/expanding the assistant across
 * successive conversations. Fails LOUD (collapse's detach wait, or the resume's
 * `embedActive` wait) if the widget does not re-mount — never a silent stale
 * compare.
 */
async function renderNextFixtureInSession(
  page: Page,
  threadId: string,
  theme: RenderTheme,
): Promise<FrameLocator> {
  // Tear down the current conversation iframe (real-visitor panel collapse).
  await collapseWidget(page);
  // Stage the NEXT fixture's seam BEFORE re-entry (the plugin reads it at mount).
  await stageSeamSignal(page, threadId, theme);
  // Re-open — a fresh iframe mount reusing the held cwu_ (re-login only on genuine
  // expiry), reading the seam just staged above.
  return resumeWidget(page);
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

      // 11 fixtures × 2 themes render inside ONE authenticated widget session: a
      // single plugin login + iframe bootstrap, then a per-fixture in-session
      // iframe re-mount (renderNextFixtureInSession). Generous budget well beyond
      // the suite's per-test default.
      test.setTimeout(20 * 60 * 1000);

      const seed = readSeed();
      const hostPage = hostPageFor(cms, seed);
      await loginFor(cms, page);

      // Flatten fixtures × themes into one ordered render plan — the FIRST entry
      // mounts the widget through the real plugin login+bootstrap ONCE, and every
      // subsequent entry re-mounts the iframe in that same authenticated session.
      const plan: Array<{ testCase: (typeof ALL_CONTENT_CASES)[number]; theme: RenderTheme }> = [];
      for (const testCase of ALL_CONTENT_CASES) {
        for (const theme of THEMES) plan.push({ testCase, theme });
      }

      const reference: NormalizedRender[] = [];
      const candidate: NormalizedRender[] = [];

      // Navigate the CMS host page ONCE. The single hosted-login handshake below
      // (one POST /api/widget-auth/init + one cwu_ mint) then serves the whole
      // corpus — every later fixture reuses that session (cinatra#1998 (c): the
      // 30/min IP limiter is CORRECT; a per-fixture re-login was the waste).
      await page.goto(hostPage, { waitUntil: "domcontentloaded" });

      for (let i = 0; i < plan.length; i += 1) {
        const { testCase, theme } = plan[i];

        // Reference: the S3 packaged renderer (sync, deterministic) — the exact
        // path /chat renders through and the goldens snapshot.
        const { html: refHtml } = REFERENCE_TARGET.renderContent(testCase.source, theme);
        reference.push({
          targetId: REFERENCE_TARGET.id,
          targetLabel: REFERENCE_TARGET.label,
          fixtureName: testCase.name,
          theme,
          normalized: await normalizeForCompare(page, refHtml),
        });

        // Candidate: seed the fixture as a thread, then render it in the widget.
        const threadId = await seedFixtureThread(request, testCase.source);
        let frame: FrameLocator;
        if (i === 0) {
          // First fixture: stage the seam signal and drive the REAL plugin
          // login + bootstrap ONCE — the sole hosted-login handshake.
          await stageSeamSignal(page, threadId, theme);
          frame = await openWidget(page);
        } else {
          // Every subsequent fixture: re-mount the widget iframe in the SAME
          // authenticated session (collapse → stage seam → re-open), reusing the
          // held cwu_ (fresh cit_ per mount) with no per-fixture login.
          frame = await renderNextFixtureInSession(page, threadId, theme);
        }
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
