import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type FrameLocator, type Page } from "@playwright/test";

import type { UatSeed } from "./global-setup";

export const WP_BASE = process.env.UAT_WP_BASE_URL ?? "http://localhost:8080";
export const DRUPAL_BASE = process.env.UAT_DRUPAL_BASE_URL ?? "http://localhost:8082";

export const WP_ADMIN_USER = process.env.UAT_WP_ADMIN_USER ?? "admin";
// Matches docker-compose.yml `WP_DEV_ADMIN_PASS: admin`.
export const WP_ADMIN_PASS = process.env.UAT_WP_ADMIN_PASS ?? "admin";
export const DRUPAL_ADMIN_USER = process.env.UAT_DRUPAL_ADMIN_USER ?? "admin";
export const DRUPAL_ADMIN_PASS = process.env.UAT_DRUPAL_ADMIN_PASS ?? "cinatra";

// Widget DOM contract after the S5 iframe cutover (wordpress-plugin/drupal-module
// #1221). The CMS-origin bundle still mounts on #cinatra-root and builds the
// launcher/panel chrome + the required-login gate as .cw-* shadow-DOM elements —
// BUT the conversation itself is no longer rendered by the bundle. It mounts the
// Cinatra-served AG-UI surface (`/embed/assistant`) in a sandboxed cross-origin
// <iframe class="cw-frame">; the textarea + submit + streaming render now live
// INSIDE that iframe. The retired shadow-DOM composer selectors (.cw-textarea /
// .cw-submit / .cw-msg-assistant) no longer exist in the shell — reach the
// composer/output through page.frameLocator(SEL.frame) instead (see EMBED below).
//
// Post-#87 (design#87): the live diff card is RETIRED — the unified
// /api/assistants/chat AG-UI stream carries no field-level `changes` payload, so
// there is no `.cw-diff*` selector to assert. The content-edit signal is the
// `*_content_editor_run` TOOL_CALL on the stream (see trackContentEditRun).
export const SEL = {
  root: "#cinatra-root",
  circle: ".cw-circle",
  panel: ".cw-panel",
  // The sandboxed cross-origin embed iframe (`/embed/assistant`) mounted into the
  // panel body once a valid per-user token is held. Playwright pierces the open
  // shadow root to locate it; page.frameLocator(SEL.frame) drives its contents.
  frame: ".cw-frame",
  // cinatra#410 required-login gate: the panel opens in 'login' mode (no valid
  // per-user token) showing a "Sign in with Cinatra" button until the hosted
  // PKCE login mints a `cwu_`; the iframe is not mounted behind it.
  login: ".cw-login",
  loginBtn: ".cw-login-btn",
  // Consent button on the hosted /widget-auth page (popup).
  consentSubmit: "button[type=submit]",
  // ---- IN-FRAME selectors (drive via page.frameLocator(SEL.frame)) ----
  // The embed page's own composer + render contract
  // (src/app/embed/assistant/embed-assistant-client.tsx).
  //
  // The embed reaches `active` only after the parent READY→BOOTSTRAP bridge +
  // the client-side capability negotiation both succeed — which additionally
  // requires the `/embed/assistant` frame-ancestors CSP to have resolved a REAL
  // registered origin (a `'none'` resolution renders the neutral error card and
  // never bootstraps), so waiting on `embedActive` is ALSO the live
  // frame-ancestors check.
  embedActive: '[data-embed-assistant][data-phase="active"]',
  embedComposerInput: 'input[aria-label="Message"]',
  embedComposerSubmit: 'button[type="submit"]',
  // One `[data-embed-content]` per assistant-text part (the S3 renderer output).
  embedAssistant: "[data-embed-content]",
  // The embed container mirrors the reduced conversation status; "finished" is a
  // CLIENT-CONSUMED RUN_FINISHED (not a mid-stream TOOL_CALL_END), so the #1214
  // edit-turn fence keys on it (see waitForEditTurnFinished).
  embedTurnFinished: '[data-embed-assistant][data-turn-status="finished"]',
} as const;

// The unified post-#87 assistant chat turn endpoint (cinatra#1221 S5). Matched
// EXACTLY (pathname === this) + method POST everywhere below, so the sibling
// `/api/assistants/chat/capabilities` negotiation POST can never be mistaken for
// a turn (a `\b`-anchored substring would match it). The widget builds this from
// a constant root-absolute path on the configured instance origin.
const CHAT_TURN_PATHNAME = "/api/assistants/chat";

/** True iff `url` is the assistant chat TURN endpoint exactly (not a subpath). */
function isChatTurnUrl(url: string): boolean {
  try {
    return new URL(url).pathname === CHAT_TURN_PATHNAME;
  } catch {
    return false;
  }
}

/**
 * Scan an AG-UI SSE body for a TOOL_CALL_START whose toolCallName equals
 * `expectedTool`. Frames are `id: <redisId>\n data: <json>\n\n`; the event
 * `type` lives IN the JSON (not on an `event:` line), matching the shipped
 * widget's own parser. Tolerates multi-line `data:` and the one-space form.
 */
function agUiStreamHasToolCall(body: string, expectedTool: string): boolean {
  return body.split("\n\n").some((record) => {
    const dataParts: string[] = [];
    for (const line of record.split("\n")) {
      if (line.indexOf("data:") === 0) {
        let value = line.slice("data:".length);
        if (value.charAt(0) === " ") value = value.slice(1);
        dataParts.push(value);
      }
    }
    if (dataParts.length === 0) return false;
    let ev: unknown;
    try {
      ev = JSON.parse(dataParts.join("\n"));
    } catch {
      return false;
    }
    return (
      typeof ev === "object" &&
      ev !== null &&
      (ev as { type?: unknown }).type === "TOOL_CALL_START" &&
      (ev as { toolCallName?: unknown }).toolCallName === expectedTool
    );
  });
}

export function readSeed(): UatSeed {
  const file = path.join(__dirname, ".uat", "seed.json");
  return JSON.parse(readFileSync(file, "utf8")) as UatSeed;
}

export async function loginWordPress(page: Page): Promise<void> {
  await page.goto(`${WP_BASE}/wp-login.php`);
  await page.fill("#user_login", WP_ADMIN_USER);
  await page.fill("#user_pass", WP_ADMIN_PASS);
  await page.click("#wp-submit");
  await page.waitForURL(/wp-admin/);
}

export async function loginDrupal(page: Page): Promise<void> {
  await page.goto(`${DRUPAL_BASE}/user/login`);
  await page.fill("#edit-name", DRUPAL_ADMIN_USER);
  await page.fill("#edit-pass", DRUPAL_ADMIN_PASS);
  await page.click("#edit-submit");
  await page.waitForLoadState("networkidle");
}

/**
 * Open the assistant panel, drive the cinatra#410 required-login gate, and return
 * a FrameLocator for the mounted `/embed/assistant` iframe with its composer live.
 *
 * After clicking the circle the panel opens. A fresh page load always mounts in
 * 'login' mode (the `cwu_` per-user token is in-memory only, lost on navigation),
 * so the conversation iframe is absent until the handshake mints one: we assert
 * the `.cw-login` gate, click "Sign in with Cinatra", drive the hosted
 * `/widget-auth` PKCE popup (which lands on consent because the browser context
 * carries the dev user's Cinatra session) by clicking "Continue", and wait for
 * the popup to close + the `cwu_` to mint. `enterConversation()` then pre-mints
 * the short-lived `cit_` site token and mounts the sandboxed cross-origin
 * `<iframe class="cw-frame">`. We wait for that iframe to attach, then for its
 * embed page to reach the negotiated `active` phase and expose the composer.
 *
 * Every wait keys on a REAL state transition (login → consent → token → iframe
 * mount → embed active), not a blanket retry/timeout. The `embedActive` wait
 * doubles as the live frame-ancestors check (a `'none'` resolution renders the
 * embed's neutral error card and never bootstraps — see SEL.embedActive).
 */
export async function openWidget(page: Page): Promise<FrameLocator> {
  // #cinatra-root is the Shadow-DOM host mount — a zero-size div, never
  // "visible" (the widget UI renders position:fixed inside its shadow root), so
  // wait for it ATTACHED, not visible.
  await page.waitForSelector(SEL.root, { state: "attached", timeout: 30_000 });
  // Wait for the IIFE to mark the mount before interacting.
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute("data-cinatra-mounted") === "true"
      || (document.querySelector(sel) as HTMLElement | null)?.dataset?.cinatraMounted === "true",
    SEL.root,
    { timeout: 30_000 },
  );
  // The circle lives in the shadow root (Playwright pierces open shadow DOM).
  await page.waitForSelector(SEL.circle, { state: "visible", timeout: 30_000 });
  await page.click(SEL.circle);
  await page.waitForSelector(SEL.panel, { timeout: 15_000 });

  // Conversation iframe already mounted? (cwu_ already valid for this context.)
  // On a fresh page load it never is (the token is in-memory), so drive login.
  const frameMounted = (await page.locator(SEL.frame).count()) > 0;
  if (!frameMounted) {
    await completeRequiredLogin(page);
  }

  // The iframe mounts only after enterConversation() pre-mints the cit_ token.
  await page.waitForSelector(SEL.frame, { state: "attached", timeout: 30_000 });
  const frame = page.frameLocator(SEL.frame);
  await frame.locator(SEL.embedActive).waitFor({ state: "visible", timeout: 30_000 });
  await frame.locator(SEL.embedComposerInput).waitFor({ state: "visible", timeout: 30_000 });
  return frame;
}

/** The mounted embed iframe's FrameLocator (read assistant output in-frame). */
export function embedFrame(page: Page): FrameLocator {
  return page.frameLocator(SEL.frame);
}

/**
 * Drive the cinatra#410 hosted-login popup to mint a `cwu_` user token. Asserts
 * the login gate, clicks the popup open, completes consent, and waits for the
 * popup to close (success path) — after which the widget swaps to conversation
 * mode and mounts the embed iframe (openWidget then waits it active).
 */
async function completeRequiredLogin(page: Page): Promise<void> {
  // The login gate must be the reason the iframe is not yet mounted — assert it loud.
  await page.waitForSelector(SEL.login, { state: "visible", timeout: 15_000 });

  // Clicking "Sign in with Cinatra" opens the hosted /widget-auth popup.
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 30_000 }),
    page.click(SEL.loginBtn),
  ]);
  await popup.waitForLoadState("domcontentloaded");

  // The browser context carries the dev user's Cinatra session, so the hosted
  // page renders the consent step (member of the txn's org). Click "Continue".
  // Target the BUTTON role explicitly: the consent page's H1 is "Continue to
  // the assistant", which a `text=Continue` substring match hits first in DOM
  // order — clicking the heading leaves the popup open forever.
  const continueBtn = popup.getByRole("button", { name: "Continue" });
  await continueBtn.waitFor({ state: "visible", timeout: 30_000 });
  await Promise.all([
    popup.waitForEvent("close", { timeout: 30_000 }),
    continueBtn.click(),
  ]);
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  // The composer lives INSIDE the sandboxed cross-origin embed iframe now; type
  // + submit through the frame (openWidget() has already waited it `active`).
  const frame = page.frameLocator(SEL.frame);
  await frame.locator(SEL.embedComposerInput).fill(text);
  await frame.locator(SEL.embedComposerSubmit).click();
}

/**
 * Post-cutover replacement for the retired page-reload fence in the #1214
 * edit-turn control. It waits for the edit turn's CLIENT-CONSUMED terminal: the
 * embed container's `data-turn-status="finished"`, mirrored from the reducer's
 * `RUN_FINISHED` transition. A completed tool chip reflects only `TOOL_CALL_END`
 * (which can precede `RUN_FINISHED`), so we key on the terminal status, not the
 * chip.
 *
 * WHY `RUN_FINISHED` IS THE COMPLETE TERMINAL (no post-fence egress race): the
 * parent bridge's `apply_intent` handler — the only client path that touches the
 * CMS after the turn (an in-place `wp.data` invalidateResolution; never a direct
 * write, never `window.location.reload()`) — runs ONLY on the renderer's EXPLICIT
 * apply gesture. The renderer NEVER auto-emits `apply_intent` on `RUN_FINISHED`,
 * and the edit scenarios deliberately do NOT click the apply affordance (scope
 * held from #1924: they assert the `*_content_editor_run` round-trip streamed +
 * no direct egress, not the parent draft refresh). So no async parent handler
 * runs after this fence — `RUN_FINISHED` is the full terminal of the edit
 * round-trip's client processing, and the only CMS-adjacent call in the entire
 * flow is the same-origin `/api/assistants/chat` POST (never a `/wp/v2` or
 * `/jsonapi` write). Await this BEFORE the egress `verify()` so the whole client
 * round-trip window has closed.
 */
export async function waitForEditTurnFinished(frame: FrameLocator): Promise<void> {
  await frame
    .locator(SEL.embedTurnFinished)
    .waitFor({ state: "attached", timeout: 30_000 });
}

/**
 * cinatra#1214 no-direct-egress assertion, LIVE inside the embedded E2E
 * (cinatra#1222 S6 acceptance criterion). The house rule: the in-admin CMS
 * assistant reaches the CMS ONLY through that CMS's MCP integration — never a
 * direct content-REST call. The AUTHORITATIVE, exhaustive guard is the
 * server-side static one (src/lib/__tests__/in-admin-cms-egress-guard.test.ts) —
 * the banned egress is server→CMS (cinatra backend → CMS content REST), which a
 * browser cannot observe. This live watcher proves the CLIENT half the embedded
 * surface CAN observe and that the static guard cannot: during the agent EDIT
 * round-trip the widget/iframe client itself issues ZERO direct CMS
 * content-MUTATION calls — the edit is applied server-side over the sanctioned
 * MCP path, so no `POST/PUT/PATCH/DELETE` to `/wp/v2/*` (WordPress) or
 * `/jsonapi/*` (Drupal) may leave the browser on the agent timeline — WHILE the
 * sanctioned cinatra assistant chat POST (`/api/assistants/chat`, the unified
 * post-#87 stream endpoint) must fire (positive control, so the assertion cannot
 * pass by the round-trip simply not happening).
 *
 * Scope discipline (no false RED): only WRITE methods are counted, and the
 * watcher is installed immediately BEFORE the prompt is sent — the CMS editor's
 * own page-load `GET /wp/v2/*` reads happen earlier and are never in the window;
 * the widget edit round-trip never types into the native editor, so no autosave
 * write fires. `verify()` is ASYNC: it first awaits the sanctioned chat
 * response body to FULLY DRAIN, so a direct write issued LATE in the round-trip
 * (mid- or post-stream, after the first terminal UI frame renders) is still
 * observed before the assertion — checking only at first-diff would let a late
 * write escape. It throws if any direct-write egress was seen or the sanctioned
 * chat POST never fired. Call BEFORE sendPrompt(); `await` it after the round-trip.
 */
export function trackNoDirectCmsEgress(
  page: Page,
  cms: "wordpress" | "drupal",
): { verify: () => Promise<void> } {
  // The exact direct content-REST surfaces #1214 rerouted onto MCP. `/wp/v2` is
  // WordPress core REST; `/jsonapi` is Drupal's JSON:API. The sanctioned MCP
  // routes (`/wp-json/mcp/...`, `/_mcp_tools`, `/mcp_jsonapi_*`) do NOT match
  // these — they carry `mcp` and `_jsonapi` (underscore), not `/jsonapi`.
  const DIRECT_CMS_CONTENT = cms === "wordpress" ? /\/wp\/v2\//i : /\/jsonapi\//i;
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  const violations: string[] = [];
  // The sanctioned assistant chat POST (`/api/assistants/chat`) response,
  // captured so verify() can await its body draining (network delivery / SSE
  // close) as the positive control. Post-#87 the widget streams here, not the
  // legacy `/agents/{slug}/stream` relay.
  //
  // NOTE on the CONSUMPTION FENCE: `.finished()` proves the response was
  // DELIVERED, not that the embed iframe fully consumed it — and when the turn is
  // captured through trackContentEditRun's route TEE the delivered body is
  // buffered, so `.finished()` resolves near-instantly. So an edit-turn caller
  // (test 5) MUST fence this verify() on the iframe's own client-consumption
  // signal — the RUN_FINISHED terminal (`waitForEditTurnFinished`) — BEFORE
  // calling it, so any direct CMS write the client would issue during tool-frame
  // processing has already been observed. A read-only turn (no edit) has no
  // client write path, so `.finished()` alone suffices there.
  let streamResponse: import("@playwright/test").Response | null = null;

  page.on("request", (req) => {
    const url = req.url();
    const method = req.method().toUpperCase();
    if (WRITE_METHODS.has(method) && DIRECT_CMS_CONTENT.test(url)) {
      violations.push(`${method} ${url}`);
    }
  });
  page.on("response", (resp) => {
    const req = resp.request();
    if (isChatTurnUrl(resp.url()) && req.method().toUpperCase() === "POST") {
      streamResponse = resp;
    }
  });

  return {
    async verify(): Promise<void> {
      expect(
        streamResponse,
        "the sanctioned cinatra assistant chat POST (/api/assistants/chat) must have fired " +
          "(positive control — the no-egress assertion must not pass merely because the " +
          "round-trip did not happen)",
      ).not.toBeNull();
      // Drain the SSE body so any late direct write on the agent timeline is
      // observed. `.finished()` resolves on stream close; guarded so an errored
      // stream cannot wedge the assertion (the outer test timeout still bounds it).
      await streamResponse!.finished().catch(() => {});
      expect(
        violations,
        `cinatra#1214 no-direct-egress VIOLATION — the ${cms} in-admin assistant client ` +
          `issued a direct CMS content-mutation call on the agent round-trip; the edit must ` +
          `route server-side over MCP, never a direct content REST write from the browser:\n` +
          violations.map((v) => `  · ${v}`).join("\n"),
      ).toEqual([]);
    },
  };
}

/**
 * cinatra#410 — install network listeners that assert the REAL dual-
 * token auth path is healthy, so the suite fails LOUD on a genuine auth
 * regression instead of timing out silently on "Thinking…"/(no response):
 *   - the same-origin broker relays for /widget-auth/{init,token} succeed (2xx),
 *   - the assistant chat POST is NOT 401 AND carries the per-user token header.
 *
 * Post-#87 the widget streams the turn to the unified `/api/assistants/chat`
 * broker-auth endpoint (not the legacy `/agents/{slug}/stream` relay); the
 * dual-token posture is byte-identical — a `cit_` site Bearer plus the per-user
 * `cwu_` on `X-Cinatra-Widget-User-Token`, fail-closed 401 on either.
 *
 * Returns a `verify()` to call after a round-trip; it throws if any expected
 * call was missing or unhealthy. Call BEFORE openWidget()/sendPrompt() so the
 * init/token/chat requests are observed.
 */
export function trackAuthPath(page: Page): { verify: () => void } {
  let initOk: boolean | null = null;
  let tokenOk: boolean | null = null;
  let streamSeen = false;
  let streamUnauthorized = false;
  let streamHadUserToken = false;

  page.on("response", (resp) => {
    const url = resp.url();
    const status = resp.status();
    // The widget talks to the SAME-ORIGIN CMS broker (cinatra/v1/widget-auth/*);
    // match on the path segment so WP (REST) and Drupal (controller) both count.
    if (/\/widget-auth\/init\b/.test(url)) initOk = status >= 200 && status < 300;
    else if (/\/widget-auth\/token\b/.test(url)) tokenOk = status >= 200 && status < 300;
    // EXACT chat-turn endpoint + POST only — never the sibling `/chat/capabilities`
    // negotiation, which carries no cwu_ header and would poison these signals.
    else if (isChatTurnUrl(url) && resp.request().method().toUpperCase() === "POST") {
      streamSeen = true;
      if (status === 401) streamUnauthorized = true;
      const headers = resp.request().headers();
      if (headers["x-cinatra-widget-user-token"]) streamHadUserToken = true;
    }
  });

  return {
    verify() {
      expect(initOk, "POST /widget-auth/init must succeed (cnx_ broker init)").toBe(true);
      expect(tokenOk, "POST /widget-auth/token must succeed (cwu_ mint)").toBe(true);
      expect(streamSeen, "the assistant chat POST (/api/assistants/chat) must have been issued").toBe(true);
      expect(streamUnauthorized, "the assistant chat POST (/api/assistants/chat) must NOT be 401").toBe(false);
      expect(
        streamHadUserToken,
        "the assistant chat POST must carry the X-Cinatra-Widget-User-Token (cwu_)",
      ).toBe(true);
    },
  };
}

/**
 * Post-#87 content-edit signal (wordpress-plugin / drupal-module #87 — the
 * OWNER-APPROVED design#87 endpoint move + diff-card retirement).
 *
 * The migration cut the widget to the unified `/api/assistants/chat` AG-UI
 * stream, which deliberately carries NO field-level `changes` diff payload — so
 * the live diff card (`.cw-diff*`) is GONE and can no longer be asserted. After
 * the S5 iframe cutover the embed page (`/embed/assistant`) renders the turn and
 * the `*_content_editor_run` `TOOL_CALL_START` frame is the content-edit signal
 * (the parent shell keys its in-place apply refresh on the frame's apply_intent
 * uplink). This tracker asserts the SAME signal at the wire — the faithful
 * post-#87 replacement for the retired diff-card round-trip assertion:
 *   - the sanctioned chat TURN POST fired (`/api/assistants/chat` exactly), AND
 *   - its AG-UI stream carried a `TOOL_CALL_START` whose `toolCallName` is the
 *     bound kind's `*_content_editor_run` (wordpress_/drupal_).
 *
 * Positive control is intrinsic: an absent/empty stream, or a turn that streams
 * no content-editor tool call, FAILS — the assertion cannot pass merely because
 * the round-trip did not happen. It observes the SAME server-verified widget
 * OBO edit round-trip the #1214 no-direct-egress guard polices; the two are
 * asserted together in test 5 (this = the edit HAPPENED; egress = it took the
 * sanctioned MCP path, never a direct browser CMS write).
 *
 * DETERMINISTIC CAPTURE (why a route TEE, not a `page.on('response')` body read):
 * the embed iframe consumes the SSE through its OWN stream reader, and the server
 * closes the SSE only after post-terminal finalization (Redis TTL etc.) — so a
 * page-side `response.text()` on the same response contends with the iframe's
 * consumption and is not guaranteed to resolve before the turn's client lifecycle
 * moves on (a false-RED). We instead intercept the turn and fetch it through
 * Playwright's API context (`route.fetch`), which is INDEPENDENT of the iframe's
 * own consumption: we read the full body, scan for the tool call, THEN fulfill
 * the iframe with the very same upstream response. The iframe's own request is
 * intercepted BEFORE it reaches the server, so the `cit_`/`cwu_` tokens are
 * consumed exactly once; the upstream headers are forwarded verbatim so the
 * iframe can still read the turn. `await install()` before sendPrompt so the
 * route is active; `await verify()` after the round-trip.
 */
export async function trackContentEditRun(
  page: Page,
  cms: "wordpress" | "drupal",
): Promise<{ verify: () => Promise<void> }> {
  const expectedTool =
    cms === "wordpress" ? "wordpress_content_editor_run" : "drupal_content_editor_run";
  let sawEditToolCall = false;
  let turnIntercepted = false;
  let routeError: string | null = null;

  await page.route(
    (url) => url.pathname === CHAT_TURN_PATHNAME,
    async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }
      try {
        // Playwright's API context replays the SAME method/headers/body and is
        // unaffected by the iframe's own stream consumption — the deterministic
        // capture point. The
        // timeout is EXPLICIT (> the suite's 30s DOM-assertion windows) so a slow
        // but valid turn is never an accidental false-red; the scripted turn is
        // sub-second, so this bound is only a backstop.
        const upstream = await route.fetch({ timeout: 60_000 });
        const body = await upstream.text();
        sawEditToolCall = agUiStreamHasToolCall(body, expectedTool);
        turnIntercepted = true;
        await route.fulfill({ response: upstream });
      } catch (err) {
        routeError = err instanceof Error ? err.message : String(err);
        // ABORT (do NOT continue): route.fetch may have already reached the
        // server and consumed the one-shot cit_/cwu_ credentials, so resending
        // the widget's original request risks a double-consume. Fail closed —
        // verify() surfaces routeError loud.
        await route.abort().catch(() => {});
      }
    },
  );

  return {
    async verify(): Promise<void> {
      expect(routeError, `intercepting the /api/assistants/chat turn failed: ${routeError}`).toBeNull();
      expect(
        turnIntercepted,
        "the sanctioned /api/assistants/chat POST must have fired (content-edit turn positive control)",
      ).toBe(true);
      expect(
        sawEditToolCall,
        `the ${cms} edit round-trip must stream a ${expectedTool} TOOL_CALL_START — the post-#87 ` +
          `content-edit signal (wordpress-plugin/drupal-module #87 retired the field-level diff ` +
          `card; the embed renders it and the parent shell keys its in-place apply refresh on it).`,
      ).toBe(true);
    },
  };
}
