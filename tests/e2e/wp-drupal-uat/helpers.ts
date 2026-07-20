import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import type { UatSeed } from "./global-setup";

export const WP_BASE = process.env.UAT_WP_BASE_URL ?? "http://localhost:8080";
export const DRUPAL_BASE = process.env.UAT_DRUPAL_BASE_URL ?? "http://localhost:8082";

export const WP_ADMIN_USER = process.env.UAT_WP_ADMIN_USER ?? "admin";
// Matches docker-compose.yml `WP_DEV_ADMIN_PASS: admin`.
export const WP_ADMIN_PASS = process.env.UAT_WP_ADMIN_PASS ?? "admin";
export const DRUPAL_ADMIN_USER = process.env.UAT_DRUPAL_ADMIN_USER ?? "admin";
export const DRUPAL_ADMIN_PASS = process.env.UAT_DRUPAL_ADMIN_PASS ?? "cinatra";

// Frozen widget DOM contract (post-rename): the bundle mounts on #cinatra-root
// and builds .cw-* elements. Specs assert against these.
export const SEL = {
  root: "#cinatra-root",
  circle: ".cw-circle",
  panel: ".cw-panel",
  textarea: ".cw-textarea",
  submit: ".cw-submit",
  assistant: ".cw-msg-assistant",
  diff: ".cw-diff, .cw-diff-footer",
  // cinatra#410 required-login gate: the panel opens in 'login' mode (no valid
  // per-user token) showing a "Sign in with Cinatra" button until the hosted
  // PKCE login mints a `cwu_`; the textarea is hidden behind it.
  login: ".cw-login",
  loginBtn: ".cw-login-btn",
  // Consent button on the hosted /widget-auth page (popup).
  consentSubmit: "button[type=submit]",
} as const;

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
 * Open the assistant panel and ensure the conversation is reachable, driving the
 * cinatra#410 required-login gate when present.
 *
 * After clicking the circle the panel opens; if the textarea is already visible
 * (a valid `cwu_` already minted) we proceed. Otherwise the panel is in the
 * 'login' mode: we assert the `.cw-login` gate, click "Sign in with Cinatra",
 * drive the hosted `/widget-auth` PKCE popup (which lands on consent because the
 * browser context carries the dev user's Cinatra session) by clicking
 * "Continue", wait for the popup to close and the `cwu_` to mint, THEN wait for
 * the textarea. Every wait keys on a REAL state transition (login → consent →
 * token → conversation), not a blanket retry/timeout.
 */
export async function openWidget(page: Page): Promise<void> {
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

  // Conversation already reachable? (cwu_ already valid for this context.)
  const textareaVisible = await page
    .locator(SEL.textarea)
    .first()
    .isVisible()
    .catch(() => false);
  if (!textareaVisible) {
    await completeRequiredLogin(page);
  }

  await page.waitForSelector(SEL.textarea, { state: "visible", timeout: 30_000 });
}

/**
 * Drive the cinatra#410 hosted-login popup to mint a `cwu_` user token. Asserts
 * the login gate, clicks the popup open, completes consent, and waits for the
 * popup to close (success path) — after which the widget swaps to conversation
 * mode and reveals the textarea.
 */
async function completeRequiredLogin(page: Page): Promise<void> {
  // The login gate must be the reason the textarea is hidden — assert it loud.
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
  await page.fill(SEL.textarea, text);
  await page.click(SEL.submit);
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
 * sanctioned cinatra agent `/stream` POST must fire (positive control, so the
 * assertion cannot pass by the round-trip simply not happening).
 *
 * Scope discipline (no false RED): only WRITE methods are counted, and the
 * watcher is installed immediately BEFORE the prompt is sent — the CMS editor's
 * own page-load `GET /wp/v2/*` reads happen earlier and are never in the window;
 * the widget edit round-trip never types into the native editor, so no autosave
 * write fires. `verify()` is ASYNC: it first awaits the sanctioned `/stream`
 * response body to FULLY DRAIN, so a direct write issued LATE in the round-trip
 * (mid- or post-stream, after the first terminal UI frame renders) is still
 * observed before the assertion — checking only at first-diff would let a late
 * write escape. It throws if any direct-write egress was seen or the sanctioned
 * stream never fired. Call BEFORE sendPrompt(); `await` it after the round-trip.
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
  // The sanctioned agent /stream POST response, captured so verify() can await
  // its body draining (SSE close) before asserting — the precise "round-trip
  // done" signal, no arbitrary sleep and no widget terminal-state selector.
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
    if (
      /\/agents\/[^/]+\/stream\b/.test(resp.url()) &&
      req.method().toUpperCase() === "POST"
    ) {
      streamResponse = resp;
    }
  });

  return {
    async verify(): Promise<void> {
      expect(
        streamResponse,
        "the sanctioned cinatra agent /stream POST must have fired (positive control — " +
          "the no-egress assertion must not pass merely because the round-trip did not happen)",
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
 *   - the agent stream POST is NOT 401 AND carries the per-user token header.
 *
 * Returns a `verify()` to call after a round-trip; it throws if any expected
 * call was missing or unhealthy. Call BEFORE openWidget()/sendPrompt() so the
 * init/token/stream requests are observed.
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
    else if (/\/agents\/[^/]+\/stream\b/.test(url)) {
      streamSeen = true;
      if (status === 401) streamUnauthorized = true;
      const req = resp.request();
      const headers = req.headers();
      if (headers["x-cinatra-widget-user-token"]) streamHadUserToken = true;
    }
  });

  return {
    verify() {
      expect(initOk, "POST /widget-auth/init must succeed (cnx_ broker init)").toBe(true);
      expect(tokenOk, "POST /widget-auth/token must succeed (cwu_ mint)").toBe(true);
      expect(streamSeen, "the agent /stream POST must have been issued").toBe(true);
      expect(streamUnauthorized, "the agent /stream POST must NOT be 401").toBe(false);
      expect(
        streamHadUserToken,
        "the agent /stream POST must carry the X-Cinatra-Widget-User-Token (cwu_)",
      ).toBe(true);
    },
  };
}
