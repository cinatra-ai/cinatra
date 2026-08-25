// C5 — the EXPIRED reading, reached by letting the shipped 30-minute window
// actually run out. Nothing is stubbed: the same thread, the same proposal the
// producer minted, reopened after its TTL.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.WALK_BASE;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const OUT = process.env.OUT_DIR;
const STATE_PATH = process.env.STATE_JSON;
const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
state.cells = state.cells || {};
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';
const url = new URL(state.expired.url);
const cookies = IDS.cookie.split("; ").map((c) => { const i = c.indexOf("="); return { name: c.slice(0,i), value: c.slice(i+1), domain: "localhost", path: "/" }; });
const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme === "dark" ? "dark" : "light" });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch {} }, theme === "dark" ? "dark" : "cinatra");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0,200)));
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForTimeout(9000);
  // Bring the card's floor into the window. The maintainer must see the control
  // the expired reading offers, and the expired notice makes the card tall
  // enough that Confirm falls behind the composer at 900px.
  await page.evaluate(() => {
    const floor = document.querySelector('[data-conformance-id="schedule-proposal-floor"]');
    floor?.scrollIntoView({ block: "center", behavior: "instant" });
    // The transcript is its own scroller; nudge it too in case the card root is
    // already pinned to the top of it.
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 300) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(2000);
  const o = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const seen = (q) => !!(root && root.querySelector(q));
    const text = root ? (root.textContent || "") : "";
    return {
      cardPresent: !!root, host: root?.getAttribute("data-lifecycle-card-host") ?? null,
      state: root?.getAttribute("data-lifecycle-card-state") ?? null,
      cardCount: document.querySelectorAll(sel).length,
      themeClass: document.documentElement.className.split(" ").pop(),
      optionRows: seen('[data-conformance-id="schedule-option-rows"]'),
      confirm: seen('[data-action="confirm-schedule-proposal"]'),
      armedSummary: seen('[data-conformance-id="schedule-armed-summary"]'),
      openRun: seen('[data-conformance-id="schedule-open-run"]'),
      chrome: seen('[data-conformance-id="scheduled-run-chrome"]'),
      saysArmed: text.includes("Armed"), saysOpenTheRun: text.includes("Open the run"),
      cardText: text.replace(/\s+/g," ").trim().slice(0,500),
    };
  }, CARD);
  const file = path.join(OUT, `C5__chat-expired__${theme}.png`);
  await page.screenshot({ path: file });
  console.log("[c5]", theme, JSON.stringify(o).slice(0,800));
  state.cells[`C5_${theme}`] = { shot: file, observed: o, url: url.toString(), capturedAt: new Date().toISOString() };
  save();
  await ctx.close();
}
await browser.close();
