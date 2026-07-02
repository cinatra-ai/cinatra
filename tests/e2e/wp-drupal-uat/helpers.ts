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
  await popup.waitForSelector(`text=Continue`, { timeout: 30_000 });
  await Promise.all([
    popup.waitForEvent("close", { timeout: 30_000 }),
    popup.click(`text=Continue`),
  ]);
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.fill(SEL.textarea, text);
  await page.click(SEL.submit);
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
