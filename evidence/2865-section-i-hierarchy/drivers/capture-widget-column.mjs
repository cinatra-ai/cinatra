// ---------------------------------------------------------------------------
// The §I widget cell: does the EMBEDDED conversation column draw the SAME
// primary composer the app's /chat column draws?
//
// Trimmed from evidence/2787-s9c-envelope-visual/drivers/05-capture-site-widget.mjs
// (same host page, same bridge, same hosted-PKCE sign-in), with the actor taken
// from the environment and the picture framed on the embed's conversation
// column instead of on a lifecycle card.
//
// The frame is loaded inside a PLAIN page on a DIFFERENT origin, so it holds no
// Cinatra cookie: it signs itself in through the hosted PKCE popup, exactly as a
// CMS visitor's widget does.
// ---------------------------------------------------------------------------
const pw = await import(process.env.CAP_PLAYWRIGHT);
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOST = process.env.CAP_HOST_PAGE;
const REPO_ROOT = process.env.CAP_REPO_ROOT;
const SHOT_REL = process.env.CAP_SHOT_REL;
const OUT_JSON = process.env.CAP_OUT_JSON;
const EMAIL = process.env.CAP_EMAIL;
const PASSWORD = process.env.CAP_PASSWORD;

const log = [];
const say = (m) => { log.push(m); console.log(m); };

const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1228, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
const stripDevOverlay = async () => {
  for (const f of page.frames()) {
    await f.evaluate(() => { document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()); }).catch(() => {});
  }
};

await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(6000);
let frame = embedFrame();
if (!frame) throw new Error("the embed frame never loaded inside the host page");
say(`embed frame url: ${frame.url()}`);

for (let i = 0; i < 90; i += 1) {
  const f = embedFrame();
  const ready = await f?.evaluate(() =>
    Boolean(document.querySelector("[data-embed-signin]")) ||
    Boolean(document.querySelector('textarea, [contenteditable="true"]')),
  ).catch(() => false);
  if (ready) { say(`embed frame drew after ~${i * 2}s`); break; }
  await page.waitForTimeout(2000);
}
frame = embedFrame();
say(`bridge: ${JSON.stringify(await page.evaluate(() => window.__s9cBridgeLog || []).catch(() => []))}`);

const signin = frame.locator("[data-embed-signin]").first();
if ((await signin.count()) > 0) {
  say("frame is anonymous — running the frame's own PKCE sign-in");
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 120000 }), signin.click()]);
  const alive = () => !popup.isClosed();
  const settle = async (ms) => { if (alive()) await popup.waitForTimeout(ms).catch(() => {}); };
  await popup.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
  say(`popup: ${alive() ? popup.url() : "<closed immediately>"}`);
  await settle(4000);
  if (alive()) {
    const email = popup.locator('input[type="email"], input[name="email"]').first();
    if ((await email.count().catch(() => 0)) > 0) {
      await email.fill(EMAIL).catch(() => {});
      await popup.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD).catch(() => {});
      await popup.locator('button[type="submit"]').first().click().catch(() => {});
      await settle(6000);
      say(`popup after sign-in: ${alive() ? popup.url() : "<closed>"}`);
    } else {
      say(`popup showed no email field; body: ${JSON.stringify(await popup.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "<unreadable>"))}`);
    }
  }
  for (let i = 0; i < 4 && alive(); i += 1) {
    const btn = popup.locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")').first();
    if ((await btn.count().catch(() => 0)) === 0) break;
    await btn.click({ timeout: 20000 }).catch(() => {});
    await settle(3000);
  }
  if (alive()) await popup.waitForEvent("close", { timeout: 90000 }).catch(() => {});
  say(`popup closed: ${popup.isClosed()}`);
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000);
    const f = embedFrame();
    const still = await f?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]"))).catch(() => true);
    if (!still) { say(`frame left its anonymous state after ~${i * 2}s`); break; }
  }
}
// Wait for the frame to reach ACTIVE, not merely to stop being anonymous:
// after the popup closes the frame sits in `authorizing` while it redeems the
// code, and a picture taken there shows the waiting card, not the column.
for (let i = 0; i < 90; i += 1) {
  const f = embedFrame();
  const phase = await f
    ?.evaluate(() => document.querySelector("[data-embed-assistant]")?.getAttribute("data-phase") ?? null)
    .catch(() => null);
  if (phase === "active") { say(`frame reached phase=active after ~${i * 2}s`); break; }
  if (i % 10 === 0) say(`frame phase after ~${i * 2}s: ${phase}`);
  await page.waitForTimeout(2000);
}
frame = embedFrame();
await page.waitForTimeout(6000);
await stripDevOverlay();

const COL = 'div.relative.flex.min-h-0.flex-1.flex-col:has([data-conversation-list]):has([data-conformance-id="chat-composer-primary"])';
const observed = await frame.evaluate((col) => {
  const n = (s) => document.querySelectorAll(s).length;
  const el = document.querySelector("[data-embed-assistant]");
  return {
    phase: el ? el.getAttribute("data-phase") : null,
    embed: n("[data-embed-assistant]"),
    embedActive: n('[data-embed-assistant][data-phase="active"]'),
    list: n("[data-conversation-list]"),
    composerPrimary: n('[data-conformance-id="chat-composer-primary"]'),
    columnFound: Boolean(document.querySelector(col)),
    bodyText: document.body.innerText.slice(0, 400),
  };
}, COL).catch((e) => ({ error: String(e).slice(0, 200) }));
say(`observed: ${JSON.stringify(observed)}`);

const shotAbs = path.join(REPO_ROOT, SHOT_REL);
fs.mkdirSync(path.dirname(shotAbs), { recursive: true });
const target = observed.columnFound ? frame.locator(COL).first() : page.locator(".cw-frame").first();
await target.screenshot({ path: shotAbs, scale: "device" }).catch(async () => {
  await page.screenshot({ path: shotAbs, fullPage: true, scale: "device" });
});
const bytes = fs.readFileSync(shotAbs);
const out = {
  screenshot: SHOT_REL,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  pixels: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
  frameUrl: frame ? new URL(frame.url()).pathname + (new URL(frame.url()).search || "") : null,
  framedOn: observed.columnFound ? "the embed's conversation column" : ".cw-frame (the column was not found)",
  observed,
  log,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log("WIDGET DONE", JSON.stringify(out.pixels), out.frameUrl);
await browser.close();
