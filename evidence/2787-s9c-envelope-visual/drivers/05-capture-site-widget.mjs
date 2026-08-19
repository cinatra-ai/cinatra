// S9c round-2 capture, step 4 — the `site_widget` cell.
//
// Drives the REAL review card inside the REAL embedded widget, on a plain page
// that is not the Cinatra app, through the BROKER path: the frame runs its own
// PKCE sign-in, holds `cit_`/`cwu_`, and every lifecycle call it makes carries
// `X-Cinatra-Widget-User-Token` with `credentials: "omit"` — no cookie.
//
// Records, beside every picture, the anchors the card itself published
// (`data-lifecycle-card-host`, `-state`, `data-lifecycle-card`,
// `data-conformance-id`), whether the record sits INSIDE the `.cw-frame` embed
// frame, and the resolve/decide envelope on the wire. A file name claims
// nothing; the log is the claim.
//
// Usage: node 05-capture-site-widget.mjs <hostPageUrl> <outDir> <stateJson>
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2];
const OUT = process.argv[3] || "/tmp/s9c-widget";
const STATE = process.argv[4];
mkdirSync(OUT, { recursive: true });

const ACTOR = { email: "s9c-capture@example.com", password: "s9c-capture-dev-12345" };

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

// ---------------------------------------------------------------------------
// The anchors, read off the card's own DOM inside the embed frame.
// ---------------------------------------------------------------------------
const ANCHOR_FN = () => {
  const card = document.querySelector("[data-lifecycle-card]");
  if (!card) return { present: false, cards: 0 };
  return {
    present: true,
    cards: document.querySelectorAll("[data-lifecycle-card]").length,
    host: card.getAttribute("data-lifecycle-card-host"),
    state: card.getAttribute("data-lifecycle-card-state"),
    kind: card.getAttribute("data-lifecycle-card"),
    conformance: card.getAttribute("data-conformance-id"),
    decisionBar: !!card.querySelector(
      '[data-conformance-id="review-gate-decision-bar"], [data-conformance-id*="decision"]',
    ),
    island: !!card.querySelector('[data-conformance-id*="island"], iframe'),
  };
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1100 },
  ...(STATE && existsSync(STATE) ? { storageState: STATE } : {}),
});
const page = await ctx.newPage();

// ---------------------------------------------------------------------------
// The wire. Request bodies are paired with their responses by url+order.
// ---------------------------------------------------------------------------
const pending = [];
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/api/lifecycle-views/")) pending.push({ url: u, body: req.postData() });
});
page.on("response", async (res) => {
  const u = res.url();
  if (!u.includes("/api/lifecycle-views/")) return;
  const req = pending.find((p) => p.url === u && !p.done);
  if (req) req.done = true;
  let body = "";
  try {
    body = (await res.text()).slice(0, 900);
  } catch {
    body = "<unreadable>";
  }
  const headers = res.request().headers();
  const carriedUserToken = Boolean(headers["x-cinatra-widget-user-token"]);
  const carriedCookie = Boolean(headers["cookie"]);
  say(`WIRE ${res.request().method()} ${new URL(u).pathname} ${res.status()}`);
  say(`  widget headers: ${JSON.stringify({
    userToken: carriedUserToken ? "present (cwu_)" : "absent",
    assistant: headers["x-cinatra-widget-assistant"] ?? null,
    origin: headers["x-cinatra-widget-origin"] ?? null,
    authorization: headers["authorization"] ? "present (cit_ bearer)" : "absent",
    cookie: carriedCookie ? "PRESENT" : "absent",
  })}`);
  if (req?.body) say(`  request : ${String(req.body).slice(0, 700)}`);
  say(`  response: ${body}`);
});

const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));

// The dev runtime paints a full-viewport `<nextjs-portal>` overlay that swallows
// pointer events and sits in every screenshot. It is dev-server furniture, not
// application UI: removing it changes no application behaviour, and without it
// the real affordances are clickable and the pictures show the surface only.
const stripDevOverlay = async () => {
  for (const f of page.frames()) {
    await f
      .evaluate(() => {
        document.querySelectorAll("nextjs-portal").forEach((n) => n.remove());
      })
      .catch(() => {});
  }
};

async function shoot(name) {
  await stripDevOverlay();
  await page.screenshot({ path: join(OUT, name), fullPage: true });
  say(`shot ${name}`);
}

try {
  say(`# site_widget capture — ${new Date().toISOString()}`);
  say(`# host page (NOT the Cinatra app): ${HOST}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(6000);

  let frame = embedFrame();
  if (!frame) throw new Error("the embed frame never loaded inside the host page");
  say(`embed frame url: ${frame.url()}`);

  // The frame must have DRAWN before anything is asked of it: on a dev runtime
  // its first paint waits on a compile, and probing earlier reads an empty body
  // and mistakes an unrendered frame for a signed-in one.
  for (let i = 0; i < 90; i += 1) {
    const f = embedFrame();
    const ready = await f
      ?.evaluate(
        () =>
          Boolean(document.querySelector("[data-embed-signin]")) ||
          Boolean(document.querySelector('textarea, [contenteditable="true"]')),
      )
      .catch(() => false);
    if (ready) {
      say(`embed frame drew after ~${i * 2}s`);
      break;
    }
    await page.waitForTimeout(2000);
  }
  frame = embedFrame();

  const bridge = await page.evaluate(() => window.__s9cBridgeLog || []).catch(() => []);
  say(`bridge handshake:\n  ${bridge.join("\n  ")}`);

  // --- the frame's own sign-in, through the hosted broker ------------------
  const signin = frame.locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("frame is anonymous — running the frame's own PKCE sign-in");
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 120_000 }),
      signin.click(),
    ]);
    // The hosted popup may complete and close at any moment; every step below is
    // closure-safe so a fast completion is a success, not a crash.
    const alive = () => !popup.isClosed();
    const settle = async (ms) => {
      if (alive()) await popup.waitForTimeout(ms).catch(() => {});
    };
    await popup.waitForLoadState("domcontentloaded", { timeout: 120_000 }).catch(() => {});
    say(`popup: ${alive() ? popup.url() : "<closed immediately>"}`);
    await settle(3000);

    if (alive()) {
      const emailField = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await emailField.count().catch(() => 0)) > 0) {
        await emailField.fill(ACTOR.email).catch(() => {});
        await popup
          .locator('input[type="password"], input[name="password"]')
          .first()
          .fill(ACTOR.password)
          .catch(() => {});
        await popup.locator('button[type="submit"]').first().click().catch(() => {});
        await settle(5000);
        say(`popup after sign-in: ${alive() ? popup.url() : "<closed>"}`);
      } else {
        say(`popup showed no email field; body: ${JSON.stringify(
          await popup.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "<unreadable>"),
        )}`);
      }
    }
    // Whatever consent/continue the hosted page shows, press it.
    for (let i = 0; i < 4 && alive(); i += 1) {
      const btn = popup
        .locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")')
        .first();
      if ((await btn.count().catch(() => 0)) === 0) break;
      await btn.click({ timeout: 20_000 }).catch(() => {});
      await settle(3000);
    }
    if (alive()) await popup.waitForEvent("close", { timeout: 90_000 }).catch(() => {});
    say(`popup closed: ${popup.isClosed()}`);

    // The frame redeems the code itself. On a cold dev runtime the redeem route
    // compiles on first hit, so wait for the frame to actually leave its
    // anonymous state rather than for a fixed number of seconds.
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(2000);
      const f = embedFrame();
      if (!f) continue;
      const stillAnonymous = await f
        .evaluate(() => Boolean(document.querySelector("[data-embed-signin]")))
        .catch(() => true);
      const text = await f.evaluate(() => document.body?.innerText?.slice(0, 120) ?? "").catch(() => "");
      if (!stillAnonymous && !/Waiting for the Cinatra sign-in/i.test(text)) {
        say(`frame left the anonymous state after ~${(i + 1) * 2}s`);
        break;
      }
      if (i % 5 === 0) say(`  waiting for the frame session… "${text.replace(/\n/g, " ").slice(0, 80)}"`);
    }
  } else {
    say("frame already carried a session");
  }

  frame = embedFrame();
  await shoot("wg-00-signed-in.png");
  say(`frame text after sign-in: ${JSON.stringify(
    await frame.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => ""),
  )}`);

  // --- the turn that pulls the review card --------------------------------
  // The shared conversation column's own composer — a contenteditable textbox,
  // addressed by its role + label so the frame's command palette can never stand
  // in for it.
  const composer = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 180_000 });
  const PROMPT = "Is there a review gate waiting for my approval?";
  await composer.click();
  await composer.type(PROMPT, { delay: 15 });
  say(`composer filled: "${PROMPT}"`);
  await stripDevOverlay();
  await composer.press("Enter");
  say("turn sent (scripted provider, no LLM call)");

  // --- pending -------------------------------------------------------------
  let anchors = null;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000);
    frame = embedFrame();
    if (!frame) continue;
    anchors = await frame.evaluate(ANCHOR_FN).catch(() => null);
    if (anchors?.present && anchors.state && anchors.state !== "loading") break;
  }
  say(`ANCHORS pending ${JSON.stringify({ ...anchors, insideEmbedFrame: true })}`);
  await shoot("wg-10-site-widget-pending-page.png");
  const cardEl = frame.locator("[data-lifecycle-card]").first();
  await cardEl.screenshot({ path: join(OUT, "wg-11-site-widget-pending-card.png") }).catch((e) => say(`card shot failed: ${e}`));
  say("shot wg-11-site-widget-pending-card.png");

  // --- the decision, pressed on the card's own floor -----------------------
  await stripDevOverlay();
  const approve = frame.locator('button:has-text("Approve")').first();
  await approve.waitFor({ state: "visible", timeout: 120_000 });
  await approve.click();
  say("approve pressed on the card floor (inside the embed frame)");

  // --- settled -------------------------------------------------------------
  let settled = null;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000);
    frame = embedFrame();
    if (!frame) continue;
    settled = await frame.evaluate(ANCHOR_FN).catch(() => null);
    if (settled?.present && settled.state === "settled") break;
  }
  say(`ANCHORS settled ${JSON.stringify({ ...settled, insideEmbedFrame: true })}`);
  await shoot("wg-12-site-widget-settled-page.png");
  await frame
    .locator("[data-lifecycle-card]")
    .first()
    .screenshot({ path: join(OUT, "wg-13-site-widget-settled-card.png") })
    .catch((e) => say(`settled card shot failed: ${e}`));
  say("shot wg-13-site-widget-settled-card.png");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "wg-error.png"), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(OUT, "capture-site_widget.txt"), log.join("\n") + "\n");
  await browser.close();
}
console.log("site_widget capture done");
