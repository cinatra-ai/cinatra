// ---------------------------------------------------------------------------
// cinatra#2865 — the §I recorder for the /chat cells.
//
// PICTURE FIRST, COUNTS SECOND. The screenshot is taken before anything is
// counted, so a record's counts can only ever be at-or-after what the picture
// shows — a card can settle or re-resolve between the two, and a count taken
// first would describe a screen the picture never held.
//
// I1/I2 are framed on the CONVERSATION COLUMN (the element carrying both the
// transcript list and the composer), scrolled to the foot of the transcript so
// the card's subordinate note field and the primary composer are in ONE frame.
// I3 is framed on the CARD ROOT, where the composer-binding row lives.
//
// Every origin, credential and path comes from the environment. Nothing about
// the lane host is written here.
// ---------------------------------------------------------------------------
// §I recorder — app /chat cells. Picture FIRST, counts SECOND (a record's counts
// can only ever be at-or-after what the picture shows).
const pw = await import(process.env.CAP_PLAYWRIGHT);
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CAP_BASE; // the lane's own loopback origin, from the environment
const REPO = process.env.CAP_REPO_ROOT;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const SEED = JSON.parse(fs.readFileSync(process.env.SEED_JSON, "utf8"));
const OUT = process.env.CAP_OUT_JSON;
const cookies = IDS.cookie.split("; ").map((c) => { const i=c.indexOf("="); return {name:c.slice(0,i),value:c.slice(i+1),domain: new URL(BASE).hostname, path: "/"}; });
const COL = 'div.relative.flex.min-h-0.flex-1.flex-col:has([data-conversation-list]):has([data-conformance-id="chat-composer-primary"])';
const CARD = '[data-conformance-id="review-gate-card"]';

const results = [];
const browser = await pw.chromium.launch({ headless: true });

const countIn = async (page) => page.evaluate(() => {
  const n = (s, ctx=document) => { try { return ctx.querySelectorAll(s).length; } catch { return -1; } };
  const root = document.querySelector('[data-lifecycle-card="artifact_review_gate"]');
  const inRoot = (s) => root ? n(s, root) : 0;
  const html = document.documentElement;
  const note = document.querySelector('[data-conformance-id="review-note-field-subordinate"]');
  const ta = note ? note.querySelector("textarea") : null;
  const comp = document.querySelector('[data-conformance-id="chat-composer-primary"]');
  const cs = (e) => e ? getComputedStyle(e) : null;
  const nb = cs(note ? note.querySelector("textarea") : null);
  const cb = cs(comp);
  return {
    frame: {
      '[data-conversation-list]': n("[data-conversation-list]"),
      '[data-lifecycle-card-host="chat_thread"]': n('[data-lifecycle-card-host="chat_thread"]'),
      '[data-lifecycle-card="artifact_review_gate"]': n('[data-lifecycle-card="artifact_review_gate"]'),
      '[data-conformance-id="chat-composer-primary"]': n('[data-conformance-id="chat-composer-primary"]'),
      '[data-conformance-id="review-note-field-subordinate"]': n('[data-conformance-id="review-note-field-subordinate"]'),
      '[data-conformance-id="review-composer-bound"]': n('[data-conformance-id="review-composer-bound"]'),
      '[data-conformance-id="review-composer-unbound"]': n('[data-conformance-id="review-composer-unbound"]'),
      '[data-lifecycle-card="recommendation_hold"]': n('[data-lifecycle-card="recommendation_hold"]'),
      '[data-skill-action]': n('[data-skill-action]'),
    },
    root: {
      '[data-conformance-id="review-decision-bar"]': inRoot('[data-conformance-id="review-decision-bar"]'),
      '[data-lifecycle-card-state]': inRoot('[data-lifecycle-card-state]'),
      '[data-conformance-id="review-note-field-subordinate"]': inRoot('[data-conformance-id="review-note-field-subordinate"]'),
    },
    theme: { htmlClass: html.className, colorScheme: getComputedStyle(html).colorScheme, bodyBg: getComputedStyle(document.body).backgroundColor },
    noteStyle: nb ? { borderBottomStyle: nb.borderBottomStyle, borderTopWidth: nb.borderTopWidth, borderBottomWidth: nb.borderBottomWidth, background: nb.backgroundColor, boxShadow: nb.boxShadow, disabled: !!(ta && ta.disabled) } : null,
    composerStyle: cb ? { borderStyle: cb.borderStyle, borderWidth: cb.borderWidth, borderColor: cb.borderColor, background: cb.backgroundColor, boxShadow: cb.boxShadow } : null,
    decisionButtons: root ? root.querySelectorAll('[data-action^="comment-review"], [data-action^="approve"], [data-action^="reject"]').length : 0,
    url: location.pathname,
    bodyText: document.body.innerText.slice(0, 500),
  };
});

async function shoot({ cell, dark, frameOn, prep, note }) {
  const ctx = await browser.newContext({ viewport: { width: 1228, height: 1400 }, deviceScaleFactor: 2, colorScheme: dark ? "dark" : "light" });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  if (dark) await page.addInitScript(() => { try { localStorage.setItem("theme","dark"); } catch {} });
  await page.goto(BASE + SEED.chatPath, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector('[data-conformance-id="review-note-field-subordinate"]', { timeout: 180000 }).catch(()=>{});
  await page.waitForTimeout(12000);
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach(n=>n.remove()));
  if (prep) await prep(page);
  await page.evaluate(() => {
    const l = document.querySelector("[data-conversation-list]");
    for (const el of [l, l?.closest("[class*=overflow]"), l?.parentElement, document.scrollingElement]) { if (el) el.scrollTop = el.scrollHeight; }
  });
  await page.waitForTimeout(2500);
  const shotRel = `evidence/2865-section-i-hierarchy/captures/${cell}.png`;
  const abs = path.join(REPO, shotRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const target = frameOn === "card" ? page.locator(CARD).first() : page.locator(COL).first();
  // PICTURE FIRST
  await target.screenshot({ path: abs, scale: "device" });
  // COUNTS SECOND
  const observed = await countIn(page);
  const bytes = fs.readFileSync(abs);
  results.push({ cell, screenshot: shotRel, sha256: createHash("sha256").update(bytes).digest("hex"),
    pixels: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
    finalUrl: page.url().replace(BASE, ""), framedOn: frameOn === "card" ? "the review card root" : "the conversation column", dark: !!dark, note, observed });
  console.log(cell, JSON.stringify(observed.frame), "note:", JSON.stringify(observed.noteStyle));
  await ctx.close();
}

await shoot({ cell: "I1__review-card__chat_thread__pending", dark: false, frameOn: "column",
  note: "§I input hierarchy, LIGHT: the ONE primary composer (boxed, raised, send affordance) and the card's subordinate note field (dashed baseline, transparent, no box) in ONE frame." });

await shoot({ cell: "I2__review-card__chat_thread__pending__dark", dark: true, frameOn: "column",
  note: "§I input hierarchy, DARK: the same two inputs, same weight difference, on the dark field." });

await shoot({ cell: "I3__review-card__chat_thread__pending__composer-bound", dark: false, frameOn: "card",
  note: "§I: one open review binds the chat box with no press — the row above the buttons states the binding and offers the box back." });

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
await browser.close();
console.log("APP CELLS DONE:", results.length);
