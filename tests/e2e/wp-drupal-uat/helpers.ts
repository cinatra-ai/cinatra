import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type FrameLocator, type Page } from "@playwright/test";

import type { DevActor, UatSeed } from "./global-setup";

export const WP_BASE = process.env.UAT_WP_BASE_URL ?? "http://localhost:8080";
export const DRUPAL_BASE = process.env.UAT_DRUPAL_BASE_URL ?? "http://localhost:8082";

export const WP_ADMIN_USER = process.env.UAT_WP_ADMIN_USER ?? "admin";
// Matches docker-compose.yml `WP_DEV_ADMIN_PASS: admin`.
export const WP_ADMIN_PASS = process.env.UAT_WP_ADMIN_PASS ?? "admin";
export const DRUPAL_ADMIN_USER = process.env.UAT_DRUPAL_ADMIN_USER ?? "admin";
export const DRUPAL_ADMIN_PASS = process.env.UAT_DRUPAL_ADMIN_PASS ?? "cinatra";

// Widget DOM contract after the S5 iframe cutover (wordpress-plugin/drupal-module
// #1221) and the PROTOCOL-2 cutover (cinatra#2674; wordpress-plugin #108 /
// drupal-module #100, both on their mains). The CMS-origin bundle still mounts on
// #cinatra-root and builds the launcher/panel chrome as .cw-* shadow-DOM elements
// — BUT the conversation itself is no longer rendered by the bundle. It mounts the
// Cinatra-served AG-UI surface (`/embed/assistant`) in a sandboxed cross-origin
// <iframe class="cw-frame">; the composer + streaming render live INSIDE that
// iframe. The retired shadow-DOM composer selectors (.cw-textarea / .cw-submit /
// .cw-msg-assistant) no longer exist in the shell — reach the composer/output
// through page.frameLocator(SEL.frame) instead (see EMBED below).
//
// WHAT PROTOCOL 2 RETIRED IN THIS CONTRACT, and why the old selectors are gone
// rather than merely unused. At protocol 1 the panel opened in a parent-owned
// 'login' mode: the CMS bundle rendered `.cw-login` + `.cw-login-btn`, ran the
// hosted PKCE handshake through same-origin CMS relays, received the `cwu_`
// per-user bearer AND minted a `cit_`, then composed both into a postMessage
// BOOTSTRAP — the iframe was not mounted until it held those tokens. The plugins'
// current mains do none of that: the panel mounts the sandboxed iframe on the
// FIRST OPEN (`openWidget` → `mountBridgeIframe`, lazily and unconditionally),
// the parent posts ONE `cinatra.embed.context` carrying public selectors only,
// and the FRAME owns the whole sign-in on the Cinatra origin in a top-level popup
// it opens itself. `.cw-login` / `.cw-login-btn` therefore no longer exist in the
// shell at all, and the relays they drove answer 410 Gone
// (`/api/widget-auth/{init,token}`). The sign-in affordance is IN-FRAME:
// `[data-embed-state="signin"]` + `[data-embed-signin]`.
//
// Post-#87 (design#87): the live diff card is RETIRED — the unified
// /api/assistants/chat AG-UI stream carries no field-level `changes` payload, so
// there is no `.cw-diff*` selector to assert. The content-edit signal is the
// `*_content_editor_run` TOOL_CALL on the stream (see trackContentEditRun).
export const SEL = {
  root: "#cinatra-root",
  circle: ".cw-circle",
  panel: ".cw-panel",
  // The sandboxed cross-origin embed iframe (`/embed/assistant`). At protocol 2
  // it is mounted by the FIRST panel open — before any sign-in — because the
  // frame is the party that signs in. Playwright pierces the open shadow root to
  // locate it; page.frameLocator(SEL.frame) drives its contents.
  frame: ".cw-frame",
  // ---- IN-FRAME selectors (drive via page.frameLocator(SEL.frame)) ----
  // The FRAME's own signed-out card + its sign-in control (protocol 2). Clicking
  // it opens a TOP-LEVEL Cinatra popup (the sandbox carries `allow-popups
  // allow-popups-to-escape-sandbox` exactly so this can happen); the parent page
  // is not a party to it and never sees the credential.
  embedSignedOut: '[data-embed-state="signin"]',
  embedSignInBtn: "[data-embed-signin]",
  // The frame while the popup is open. A ceremony that fails neutrally (a blocked
  // popup, a cancelled sign-in) drops BACK to `embedSignedOut` from here — which
  // is why the drive below waits on `embedActive` and fails on its own budget
  // rather than waiting out a silent return to the signed-out card.
  embedAuthorizing: '[data-embed-state="authorizing"]',
  // The embed page's own composer + render contract
  // (src/app/embed/assistant/embed-assistant-client.tsx).
  //
  // At protocol 2 the embed reaches `active` only after ALL of: the parent
  // READY→CONTEXT bridge delivered its public selectors, the FRAME's own sign-in
  // ceremony redeemed a credential (`/api/widget-auth/frame/{init,token}`), and
  // the client-side capability negotiation succeeded — which additionally
  // requires the `/embed/assistant` frame-ancestors CSP to have resolved a REAL
  // registered origin (a `'none'` resolution renders the neutral error card and
  // never bootstraps), so waiting on `embedActive` is ALSO the live
  // frame-ancestors check.
  embedActive: '[data-embed-assistant][data-phase="active"]',
  // cinatra#2683 (epic #2564 S8f): the embed's bespoke single-line `<input>` is
  // gone. The widget now mounts the SAME composer `/chat` mounts (`PromptField`,
  // a contenteditable editor with the circular icon send control), so these
  // selectors are the shared composer's own hooks — identical on both surfaces,
  // which is the point of the slice.
  embedComposerInput: '[data-testid="chat-prompt-input"]',
  // The send control is STILL a JS-driven `type="button"`, not a form submit:
  // the embed runs inside the CMS widget's `sandbox="allow-scripts
  // allow-same-origin"` iframe, which grants no `allow-forms`, so a native form
  // submission is blocked and never fires. PromptField submits from onClick /
  // Enter inside a plain <div>, so nothing depends on form submission being
  // permitted. While a turn runs the SAME control becomes "Stop generating".
  //
  // PRESENCE hook: `sendPrompt` submits with Enter rather than by clicking this,
  // because in the dev server the composer's bottom-right corner is under the
  // Next.js dev-overlay portal — see the note there.
  embedComposerSubmit: 'button[aria-label="Send message"]',
  embedComposerStop: 'button[aria-label="Stop generating"]',
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

/**
 * The deterministic dev UAT actor, as `dev-auto-setup`'s `ensureDevConnectActor`
 * seeds it on every dev-server boot (global-setup asserts the file exists before
 * any spec runs). At protocol 2 these are the credentials the FRAME's sign-in
 * popup is driven with when it presents its own sign-in screen — the popup is a
 * top-level Cinatra document, so this is a first-party sign-in on the Cinatra
 * origin and the CMS page is not a party to it.
 */
export function readDevActor(): DevActor {
  const file = path.join(__dirname, ".uat", "dev-actor.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DevActor;
  } catch (error) {
    throw new Error(
      `[wp-drupal-uat] dev UAT actor not found at ${file} — the protocol-2 sign-in ` +
        `popup has no credentials to type. dev-auto-setup (ensureDevConnectActor) ` +
        `writes it on the dev-server boot; global-setup reads it too, so if this ` +
        `throws the setup did not run. Cause: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * THE CEREMONY BUDGET (cinatra#2708).
 *
 * The protocol-2 sign-in ceremony — panel open → frame signed-out card → popup →
 * credentials → `active` — was MEASURED at 19.7s uninstrumented on a warm dev
 * server (host2, matrix-chromium, both CMSes). Every wait inside `openWidget` is
 * therefore bounded by what is LEFT of this budget rather than by its own
 * generous ceiling: a ceremony that stalls fails with a named budget error naming
 * the phase it died in, instead of drifting to the 120s per-test timeout (or, in
 * the egress spec, to whatever ceiling that spec sets) with no diagnosis.
 *
 * 60s is 3x the measured baseline — headroom for a CI runner that is slower than
 * a warm workstation, while still failing loud well inside the per-test ceiling
 * so the failure names the ceremony rather than the runner. Raise it with
 * UAT_CEREMONY_BUDGET_MS on a host that genuinely needs more; do not raise the
 * per-test timeout instead, which is what re-hides the hang this bound exists to
 * surface.
 */
export const CEREMONY_BUDGET_MS = Number(process.env.UAT_CEREMONY_BUDGET_MS ?? 60_000);

/** A monotonic countdown over the ceremony budget; throws the moment it is out. */
function ceremonyDeadline(): { left: (phase: string) => number; elapsed: () => number } {
  const startedAt = Date.now();
  return {
    left(phase: string): number {
      const remaining = startedAt + CEREMONY_BUDGET_MS - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `[wp-drupal-uat] the protocol-2 sign-in ceremony exceeded its ` +
            `${CEREMONY_BUDGET_MS}ms budget at phase "${phase}" (cinatra#2708 — the ` +
            `measured uninstrumented baseline is ~19.7s). This is a REAL failure of the ` +
            `ceremony, not a harness timeout: the drive is bounded on purpose so a stall ` +
            `is named here instead of hanging to the per-test ceiling. Raise ` +
            `UAT_CEREMONY_BUDGET_MS only if the host is genuinely slower.`,
        );
      }
      return remaining;
    },
    elapsed(): number {
      return Date.now() - startedAt;
    },
  };
}

export async function loginWordPress(page: Page): Promise<void> {
  // cinatra#2131 — this sign-in was burning a WHOLE-TEST retry. The docker
  // WordPress is still warming its first requests while the suite starts, so on
  // a loaded runner either half of the sign-in can miss: `page.goto` lands on a
  // connection reset or a document without the login markup, or the credential
  // POST's redirect to wp-admin does not arrive inside the bound.
  //
  // Both halves are now retried IN PLACE, bounded, with an explicit wait on the
  // login form — never by letting the runner replay the entire test. A
  // whole-test retry costs minutes on a runner that is already
  // memory-constrained, hides the real signal behind a green-on-retry, and
  // re-runs everything the test had already proven. This mirrors the shape
  // `loginDrupal` below already uses for the same reason.
  //
  // TIMING BUDGET — keep the worst case under the 120s per-test timeout in
  // tests/e2e/config/wp-drupal-uat.config.ts: 3 attempts x (15s form wait + 30s
  // redirect wait) leaves headroom, and a successful attempt returns as soon as
  // the redirect lands. Do not raise these bounds without re-checking that sum;
  // a per-attempt bound that is generous enough to blow the per-test ceiling
  // converts a retryable miss back into the whole-test retry this removes.
  const loginForm = page.locator("#loginform");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${WP_BASE}/wp-login.php`, { waitUntil: "domcontentloaded" });
      // A live session is redirected straight into wp-admin; nothing to do.
      if (/\/wp-admin/.test(page.url())) return;
      // Explicit wait on the form itself — reaching `domcontentloaded` does not
      // mean the login markup is there (a PHP fatal or an in-flight bootstrap
      // both render a document without it).
      await loginForm.waitFor({ state: "visible", timeout: 15_000 });
      await page.locator("#user_login").waitFor({ state: "visible", timeout: 5_000 });
      await page.fill("#user_login", WP_ADMIN_USER);
      await page.fill("#user_pass", WP_ADMIN_PASS);
      await page.click("#wp-submit");
      await page.waitForURL(/wp-admin/, { timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(1_000);
    }
  }
  throw new Error(
    `[wp-drupal-uat] wp-admin sign-in did not reach an authenticated /wp-admin URL after 3 ` +
      `attempts against ${WP_BASE}/wp-login.php (last page: ${page.url()}). ` +
      `Cause: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function loginDrupal(page: Page): Promise<void> {
  // The Drupal assistant surface is permission-gated (_cinatra_widget_applies
  // requires "use cinatra assistant"), so an unauthenticated page load attaches
  // NEITHER the widget bundle NOR the fallback chrome. A bare
  // `waitForLoadState("networkidle")` after the submit resolves on the RELOADED
  // login form too, so a transient login miss would silently proceed as an
  // ANONYMOUS session — and every downstream widget assertion would then fail
  // confusingly (e.g. the fallback test observes ZERO widget-bundle requests
  // because the bundle was never attached, not because its abort fired). Assert
  // we actually reach the authenticated redirect (Drupal sends a successful
  // login to `/user/{uid}`), and retry the whole login a few times so a flaky
  // first sign-in self-heals instead of poisoning the test.
  const authed = /\/user\/\d+(?:[/?#]|$)/;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${DRUPAL_BASE}/user/login`, { waitUntil: "domcontentloaded" });
    // A live session already redirects /user/login → /user/{uid}; nothing to do.
    if (authed.test(page.url())) return;
    await page.fill("#edit-name", DRUPAL_ADMIN_USER);
    await page.fill("#edit-pass", DRUPAL_ADMIN_PASS);
    await page.click("#edit-submit");
    try {
      await page.waitForURL(authed, { timeout: 20_000 });
      return;
    } catch {
      if (attempt === 3) {
        throw new Error(
          `[wp-drupal-uat] Drupal admin login did not authenticate after 3 attempts ` +
            `(still at ${page.url()} — expected a /user/{uid} redirect). The widget ` +
            `surface is permission-gated, so an anonymous session silently fails every ` +
            `widget assertion.`,
        );
      }
    }
  }
}

/**
 * Open the assistant panel, drive the PROTOCOL-2 sign-in ceremony, and return a
 * FrameLocator for the mounted `/embed/assistant` iframe with its composer live.
 *
 * THE CEREMONY (cinatra#2674; wordpress-plugin #108 / drupal-module #100 on their
 * mains), phase by phase — every wait keys on a REAL state transition:
 *
 *   1. `#cinatra-root` attaches and the bundle's IIFE marks `data-cinatra-mounted`.
 *   2. The launcher circle is clicked. The panel opens AND — new at protocol 2 —
 *      the sandboxed `<iframe class="cw-frame">` is mounted right there, on the
 *      first open, before anyone has signed in. The parent posts ONE
 *      `cinatra.embed.context` carrying PUBLIC selectors (which site, which
 *      agent, which resource); it composes no bearer and holds none.
 *   3. The FRAME renders its own signed-out card (`[data-embed-state="signin"]`).
 *      This is the transition the retired drive could never reach: at protocol 1
 *      the parent rendered `.cw-login` and the iframe did not exist yet.
 *   4. Clicking the frame's `[data-embed-signin]` opens a TOP-LEVEL Cinatra popup
 *      that the FRAME opened (`window.open` on the authorize URL from
 *      `/api/widget-auth/frame/init`). The popup is first-party on the Cinatra
 *      origin, which is why the sign-in works in browsers that block third-party
 *      cookies outright.
 *   5. The popup is driven to completion (see `finishFrameSignIn`) and closes
 *      itself; the frame redeems the code at `/api/widget-auth/frame/token` and
 *      holds the credential pair in a closure. NOTHING is handed to the parent.
 *   6. The embed negotiates capabilities and reaches `active` with the shared
 *      composer mounted.
 *
 * The whole thing is bounded by {@link CEREMONY_BUDGET_MS} (cinatra#2708), not by
 * per-wait ceilings: a ceremony that dies neutrally — a blocked popup drops the
 * frame back to its signed-out card and reports nothing — is named here, at the
 * phase it died in, rather than running out the per-test timeout.
 *
 * The `embedActive` wait doubles as the live frame-ancestors check (a `'none'`
 * resolution renders the embed's neutral error card and never bootstraps — see
 * SEL.embedActive).
 */
export async function openWidget(page: Page): Promise<FrameLocator> {
  const budget = ceremonyDeadline();

  // #cinatra-root is the Shadow-DOM host mount — a zero-size div, never
  // "visible" (the widget UI renders position:fixed inside its shadow root), so
  // wait for it ATTACHED, not visible.
  await page.waitForSelector(SEL.root, { state: "attached", timeout: budget.left("widget mount") });
  // Wait for the IIFE to mark the mount before interacting.
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute("data-cinatra-mounted") === "true"
      || (document.querySelector(sel) as HTMLElement | null)?.dataset?.cinatraMounted === "true",
    SEL.root,
    { timeout: budget.left("widget mount") },
  );
  // The circle lives in the shadow root (Playwright pierces open shadow DOM).
  await page.waitForSelector(SEL.circle, { state: "visible", timeout: budget.left("launcher") });
  await page.click(SEL.circle);
  await page.waitForSelector(SEL.panel, { timeout: budget.left("panel open") });

  // Protocol 2: the iframe is mounted BY the open, unconditionally — no token is
  // held and none is needed to mount it.
  await page.waitForSelector(SEL.frame, {
    state: "attached",
    timeout: budget.left("frame mount"),
  });
  const frame = page.frameLocator(SEL.frame);

  // The frame's OWN signed-out card. If the frame is already `active` (a context
  // that still holds a live frame session — not the case on a fresh document,
  // where the credential died with the previous document) there is nothing to
  // sign in to; the active wait below is then immediate.
  const signedOut = frame.locator(SEL.embedSignedOut);
  const active = frame.locator(SEL.embedActive);
  // ONE wait on the union, never a Promise.race of two waits: the loser of a race
  // keeps running and rejects into an unhandled rejection long after the test has
  // moved on. A CSS selector list settles on whichever card renders first.
  await frame
    .locator(`${SEL.embedSignedOut}, ${SEL.embedActive}`)
    .first()
    .waitFor({ state: "visible", timeout: budget.left("frame signed-out card") });

  if (await signedOut.isVisible().catch(() => false)) {
    const popup = await startFrameSignIn(page, frame, budget.left("sign-in popup"));
    await finishFrameSignIn(popup, readDevActor(), budget.left("popup sign-in"));
  }

  await active.waitFor({ state: "visible", timeout: budget.left("embed active") });
  await frame
    .locator(SEL.embedComposerInput)
    .waitFor({ state: "visible", timeout: budget.left("composer") });
  console.log(`[wp-drupal-uat] protocol-2 ceremony reached active in ${budget.elapsed()}ms`);
  return frame;
}

/** The mounted embed iframe's FrameLocator (read assistant output in-frame). */
export function embedFrame(page: Page): FrameLocator {
  return page.frameLocator(SEL.frame);
}

/**
 * cinatra#2713 — bounded wait for a review card's §III island to have
 * PAINTED before a proof-capture screenshot fires.
 *
 * `ReviewTargetIsland` (packages/agents/src/review-gate-card.tsx) marks its
 * own load state on the SAME element the design's conformance anchor already
 * names — `data-conformance-id="review-target-island"` gains
 * `data-island-load-state`: `"loading"` while its skeleton shows, `"loaded"`
 * once the nested iframe's `load` event lands, `"timed-out"` past the card's
 * own bound. A screenshot taken without this wait can catch the FIRST of
 * those — the bare white box the 333 proof round photographed
 * (evidence/2674-s8e V5 vs V6, same session, both CMSes) and the owner caught.
 *
 * Waits for `"loaded"` SPECIFICALLY, not merely "away from loading": a capture
 * round that reaches `"timed-out"` instead is a real regression worth failing
 * the run on, not a state worth a "painted" screenshot. Call this immediately
 * before any screenshot/proof capture of a card that carries a review-target
 * island (the review gate card, on any host — chat thread, run card, page
 * gate region, or here, the site widget).
 */
export async function waitForIslandPaint(frame: FrameLocator, timeoutMs = 20_000): Promise<void> {
  await expect(
    frame.locator('[data-conformance-id="review-target-island"]'),
    "the review card's §III island did not reach " +
      'data-island-load-state="loaded" in time — a screenshot taken now would ' +
      "recreate the V5 blank-frame defect (cinatra#2713)",
  ).toHaveAttribute("data-island-load-state", "loaded", { timeout: timeoutMs });
}

/**
 * Click the FRAME's own sign-in control and return the top-level Cinatra popup it
 * opens.
 *
 * The popup grant is not incidental: the plugin's iframe sandbox carries exactly
 * `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
 * and the last two exist so this `window.open` is possible at all and so the
 * window it opens is an ORDINARY top-level document (a popup that merely
 * inherited the sandbox would have no forms and could not complete a sign-in).
 * A `popup` event that never arrives therefore means one of two real defects —
 * the sandbox lost a token, or the frame's `/api/widget-auth/frame/init` was slow
 * enough to spend the browser's transient user activation before `window.open`
 * (which is why global-setup warms that route). Both fail here, loudly.
 */
async function startFrameSignIn(
  page: Page,
  frame: FrameLocator,
  timeout: number,
): Promise<Page> {
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout }),
    frame.locator(SEL.embedSignInBtn).click({ timeout }),
  ]);
  // A popup that already holds a Cinatra session can post its code back and
  // CLOSE ITSELF before this settles; that is the fast success path, not a
  // failure, and every wait on a closed page throws. Swallow it and let
  // `finishFrameSignIn` decide from the popup's state.
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  return popup;
}

/**
 * Drive the Cinatra-origin popup to completion and wait for it to close itself.
 *
 * TWO LEGITIMATE PATHS, and the drive must not assume either.
 *   • The popup presents Cinatra's own sign-in screen. It is typed with the
 *     seeded dev actor's credentials — a FIRST-PARTY sign-in on the Cinatra
 *     origin. The CMS page cannot see this window's contents at all.
 *   • The popup lands already authenticated (this suite's storageState carries a
 *     Cinatra session for the same actor, scoped to the instance origin where the
 *     popup opens). It then goes straight to its return step and closes itself.
 * The drive polls for whichever arrives, so a config with or without a saved
 * session both exercise the real journey and neither wastes the budget waiting
 * for a screen that will not appear.
 *
 * TYPE, NEVER `fill()` — the lesson the s8e lane paid for. `fill()` sets the
 * value and fires ONE synthetic `input`; the popup's controlled inputs did not
 * register that under Firefox, so the form came back "Email is invalid /
 * Password is required" and the ceremony stalled with the frame sitting correctly
 * at `authorizing`. That read as an engine failure and was not one — no request
 * ever 4xx'd. Typing key-by-key drives the same events a person does, in every
 * engine.
 *
 * The password is checked by LENGTH ONLY. Never assert on its value: a failed
 * assertion prints the expected value into the report.
 */
async function finishFrameSignIn(
  popup: Page,
  actor: DevActor,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const email = popup.locator('input[name="email"], input[type="email"]').first();

  let sawForm = false;
  while (Date.now() < deadline) {
    if (popup.isClosed()) return; // it had a session and returned itself
    if (await email.isVisible().catch(() => false)) {
      sawForm = true;
      break;
    }
    // A PLAIN timer, never `popup.waitForTimeout` — the popup can close DURING
    // this pause (the already-authenticated path returns itself in well under a
    // second), and every wait on a closed page throws. A wait that dies because
    // the thing it is waiting for succeeded is the worst kind of flake: it fails
    // exactly on the fast path.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!sawForm) {
    if (popup.isClosed()) return;
    throw new Error(
      `[wp-drupal-uat] the Cinatra sign-in popup neither presented its sign-in form ` +
        `nor returned itself within the ceremony budget (still open at ${popup.url()}). ` +
        `The frame is left at [data-embed-state="authorizing"] and would never reach active.`,
    );
  }

  const password = popup.locator('input[name="password"], input[type="password"]').first();
  await email.click();
  await email.pressSequentially(actor.email, { delay: 12 });
  await password.click();
  await password.pressSequentially(actor.password, { delay: 12 });

  // Both fields must really hold what we typed before the submit is meaningful.
  await expect(email).toHaveValue(actor.email);
  expect(
    (await password.inputValue()).length,
    "the password field did not receive the typed value",
  ).toBe(actor.password.length);

  const labelled = popup
    .locator('button[type="submit"]')
    .filter({ hasText: /log ?in|sign ?in/i });
  const submit =
    (await labelled.count()) > 0 ? labelled.first() : popup.locator('button[type="submit"]').first();
  await submit.click();

  // The return step posts {code, state} to the CINATRA ORIGIN — to the frame that
  // opened it, never to the CMS page — and closes itself.
  if (!popup.isClosed()) {
    await popup
      .waitForEvent("close", { timeout: Math.max(1_000, deadline - Date.now()) })
      .catch(() => {
        /* the return step may already have closed it — the active wait decides */
      });
  }
}

// NO in-session re-mount helper (collapse→resume) exists: grounding against the
// LIVE plugin (wordpress-plugin `assets/cinatra-widget.js` / drupal-module
// `js/cinatra-widget.js`, current mains) disproved that model — `collapseWidget`
// only toggles `cwWidget.style.display`, it NEVER tears the frame down, and
// re-opening merely un-hides the SAME already-mounted frame. The iframe is
// mounted exactly once per document (`mountBridgeIframe`'s `if (iframeEl) return`
// guard, reached from the first `openWidget` panel open), so nothing in a live
// session produces a second frame. A fresh embed iframe (fresh nonce + fresh
// `parityThread` src) therefore requires a full document reload — which at
// protocol 2 also re-runs the sign-in, because the frame's credential lives in a
// closure and dies with its document (the documented, deliberate cost of holding
// it there instead of in a cookie). {@link openWidget} on a freshly-`goto`'d host
// page is that path (see render-parity.ts `renderFixtureFresh`).

export async function sendPrompt(page: Page, text: string): Promise<void> {
  // The composer lives INSIDE the sandboxed cross-origin embed iframe now; type
  // + submit through the frame (openWidget() has already waited it `active`).
  const frame = page.frameLocator(SEL.frame);
  // A contenteditable is filled, not `.fill()`-ed like an <input> — Playwright's
  // fill() works on contenteditable too and dispatches the `input` event the
  // composer learns its value from, so this stays one call.
  const editor = frame.locator(SEL.embedComposerInput);
  await editor.fill(text);
  // SUBMIT WITH ENTER, NOT BY CLICKING THE SEND CONTROL (cinatra#2683).
  //
  // Since S8f the widget mounts the SAME composer `/chat` mounts, whose send
  // control is a circular icon button pinned to the composer's bottom-right
  // corner. In the DEV server this suite drives, that corner is exactly where
  // Next.js parks its dev-overlay portal — so the click retried for 30s against
  // "<nextjs-portal> … intercepts pointer events" while the button itself was
  // visible, enabled and stable. Nothing about the widget was wrong; the overlay
  // was on top of it.
  //
  // Enter is the same submit path (`PromptField` handles the keydown itself) and
  // is the gesture a reader actually uses. It is also still sandbox-safe: the
  // composer is a contenteditable in a plain <div>, never a <form>, so no part of
  // this depends on `allow-forms`, which the CMS widget's iframe does not grant.
  await editor.press("Enter");
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

// The protocol-2 frame-owned ceremony's two routes, and the RETIRED site-mediated
// pair they replaced. Matched by exact pathname on the CINATRA origin: the retired
// names are prefixes of nothing, but `/api/widget-auth/frame/init` contains
// `widget-auth`, so a loose substring match would confuse the two — and confusing
// them is precisely the regression this tracker exists to catch.
const FRAME_INIT_PATHNAME = "/api/widget-auth/frame/init";
const FRAME_TOKEN_PATHNAME = "/api/widget-auth/frame/token";
const RETIRED_AUTH_PATHNAMES = ["/api/widget-auth/init", "/api/widget-auth/token"] as const;

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * cinatra#2674 (protocol 2) — install network listeners that assert the REAL
 * frame-owned auth path is healthy, so the suite fails LOUD on a genuine auth
 * regression instead of timing out silently on "Thinking…"/(no response):
 *   - the FRAME's own same-origin ceremony routes succeed (2xx):
 *     `POST /api/widget-auth/frame/init` (transaction start, no credential
 *     presented) and `POST /api/widget-auth/frame/token` (PKCE redeem),
 *   - the RETIRED site-mediated pair is never called at all,
 *   - the assistant chat POST is NOT 401 AND carries the per-user token header.
 *
 * WHY THE RETIRED-PAIR ASSERTION IS PART OF THE HEALTH CHECK, not decoration.
 * `/api/widget-auth/{init,token}` answer 410 Gone. A drive that still called them
 * would fail somewhere downstream with a confusing symptom — the frame sitting at
 * `authorizing`, a panel that never activates — and a reader would spend the
 * failure hunting the widget. Asserting the retired pair was NOT touched names
 * that regression at its cause: something (the plugin, or this suite) is still
 * running the site-mediated ceremony.
 *
 * The dual-token posture ON THE TURN is unchanged by protocol 2 — a `cit_` site
 * Bearer plus the per-user `cwu_` on `X-Cinatra-Widget-User-Token`, fail-closed
 * 401 on either. What changed is WHO HOLDS THEM: the frame mints and keeps both
 * in a closure on the Cinatra origin; the CMS page composes neither and sees
 * neither. Both requests are issued BY THE FRAME, and page-level listeners
 * observe subframe requests, so this tracker still sees them.
 *
 * Returns a `verify()` to call after a round-trip; it throws if any expected
 * call was missing or unhealthy. Call BEFORE openWidget()/sendPrompt() so the
 * init/token/chat requests are observed.
 */
export function trackFrameAuthPath(page: Page): { verify: () => void } {
  let frameInitOk: boolean | null = null;
  let frameTokenOk: boolean | null = null;
  const retiredCalls: string[] = [];
  let streamSeen = false;
  let streamUnauthorized = false;
  let streamHadUserToken = false;

  page.on("response", (resp) => {
    const url = resp.url();
    const status = resp.status();
    const pathname = pathnameOf(url);
    if (pathname === FRAME_INIT_PATHNAME) frameInitOk = status >= 200 && status < 300;
    else if (pathname === FRAME_TOKEN_PATHNAME) frameTokenOk = status >= 200 && status < 300;
    else if ((RETIRED_AUTH_PATHNAMES as readonly string[]).includes(pathname)) {
      retiredCalls.push(`${resp.request().method()} ${pathname} -> ${status}`);
    }
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
      expect(
        frameInitOk,
        "POST /api/widget-auth/frame/init must succeed (the FRAME starts its own PKCE " +
          "transaction, same-origin, presenting no credential)",
      ).toBe(true);
      expect(
        frameTokenOk,
        "POST /api/widget-auth/frame/token must succeed (the FRAME redeems the code with " +
          "the verifier that never left its closure)",
      ).toBe(true);
      expect(
        retiredCalls,
        "the RETIRED site-mediated auth pair (/api/widget-auth/init, /api/widget-auth/token — " +
          "410 Gone since cinatra#2674) must not be called by anything in this flow",
      ).toEqual([]);
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
