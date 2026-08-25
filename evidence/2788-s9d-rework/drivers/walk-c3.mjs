// C3 — the RUN PAGE with the schedule step open, on the one real run.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.WALK_BASE;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const RUN = process.env.RUN_ID;
const OUT = process.env.OUT_DIR;
const STATE_PATH = process.env.STATE_JSON;
const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
state.cells = state.cells || {};
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';
const cookies = IDS.cookie.split("; ").map((c) => { const i = c.indexOf("="); return { name: c.slice(0,i), value: c.slice(i+1), domain: "localhost", path: "/" }; });
const browser = await chromium.launch();

async function ctxFor(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme === "dark" ? "dark" : "light" });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch {} }, theme === "dark" ? "dark" : "cinatra");
  return ctx;
}
async function observe(page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const seen = (q) => !!(root && root.querySelector(q));
    const text = root ? (root.textContent || "") : "";
    const pageText = document.body.textContent || "";
    return {
      cardPresent: !!root, host: root?.getAttribute("data-lifecycle-card-host") ?? null,
      state: root?.getAttribute("data-lifecycle-card-state") ?? null,
      cardCount: document.querySelectorAll(sel).length,
      themeClass: document.documentElement.className.split(" ").pop(),
      railStepOpen: !!document.querySelector('[data-conformance-id="schedule-step-detail"]'),
      optionRows: seen('[data-conformance-id="schedule-option-rows"]'),
      save: seen('[data-action="save-schedule-changes"]'),
      cancel: seen('[data-action="cancel-trigger-schedule"]'),
      release: seen('[data-action="release-trigger-now"]'),
      cancelLabel: root?.querySelector('[data-action="cancel-trigger-schedule"]')?.textContent?.trim() ?? null,
      releaseLabel: root?.querySelector('[data-action="release-trigger-now"]')?.textContent?.trim() ?? null,
      chrome: seen('[data-conformance-id="scheduled-run-chrome"]'),
      gatedSteps: seen('[data-conformance-id="schedule-gated-steps"]'),
      armedSummary: seen('[data-conformance-id="schedule-armed-summary"]'),
      openRun: seen('[data-conformance-id="schedule-open-run"]'),
      saysTriggerConfiguration: text.includes("Trigger configuration"),
      saysStepsHeld: text.includes("Steps held until trigger fires"),
      saysArmed: text.includes("Armed"),
      saysOpenTheRun: text.includes("Open the run"),
      saysCancelTrigger: text.includes("Cancel trigger"),
      saysReleaseNow: text.includes("Release now"),
      pageSaysSchedule: pageText.includes("Schedule"),
      cardText: text.replace(/\s+/g, " ").trim().slice(0, 500),
    };
  }, CARD);
}
for (const theme of ["light", "dark"]) {
  const ctx = await ctxFor(theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0,200)));
  await page.goto(`${BASE}/agents/cinatra-ai/planner-agent/${RUN}`, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(6000);
  // Open the schedule step with a REAL press of the rail row.
  const opener = '[data-action="open-schedule-step"]';
  const found = await page.waitForSelector(opener, { timeout: 180000 }).catch(() => null);
  if (!found) { console.log("NO schedule rail row on the run page"); await page.screenshot({ path: path.join(OUT, `C3__DEBUG__${theme}.png`) }); await ctx.close(); continue; }
  await page.click(opener);
  await page.waitForTimeout(3500);
  const o = await observe(page);
  const file = path.join(OUT, `C3__run-page-schedule-step__${theme}.png`);
  await page.screenshot({ path: file });
  console.log("[c3]", theme, JSON.stringify(o).slice(0, 900));
  state.cells[`C3_${theme}`] = { shot: file, observed: o, url: page.url() };
  save();
  await ctx.close();
}
await browser.close();
