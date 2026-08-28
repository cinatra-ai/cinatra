// PAGE CONTROLS — the sidecar beside the capture index.
//
// These are NOT records of scripts/ci/chat-hitl-capture-index.json: every record
// of that index asserts `[data-lifecycle-card-host="<host>"]`, and the screens
// this file photographs draw NO lifecycle card, which is exactly what the cells
// prove. Every count is read off the LIVE page through the shipped recorder's
// own `playwrightPage` port — the same reader `observeCapture` measures a walk
// cell with. It writes NO verdict: the verdicts are graded from the pixels.
//
// Every capture is the FULL BROWSER WINDOW at 1440x900, deviceScaleFactor 2.
// Nothing here writes to the database.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";
import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";

const PLAN = JSON.parse(readFileSync(process.argv[2], "utf8"));
const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.PC_OUT_JSON ?? "evidence/2936-w6-captures/page-controls.json";
if (!BASE || !DB) throw new Error("needs WALK_BASE and SUPABASE_DB_URL");

const READ = () => ({
  lifecycleCards: Array.from(document.querySelectorAll("[data-lifecycle-card]")).map((e) => ({
    kind: e.getAttribute("data-lifecycle-card"),
    state: e.getAttribute("data-lifecycle-card-state"),
    host: e.getAttribute("data-lifecycle-card-host"),
  })),
  lifecycleCardHosts: document.querySelectorAll("[data-lifecycle-card-host]").length,
  confirmScheduleProposal: document.querySelectorAll('[data-action="confirm-schedule-proposal"]').length,
  saveScheduleChanges: document.querySelectorAll('[data-action="save-schedule-changes"]').length,
  scheduleRailStep: document.querySelectorAll('[data-conformance-id="schedule-rail-step"]').length,
  runSurface: document.querySelectorAll('[data-conformance-id="run-surface"]').length,
  conversationList: document.querySelectorAll("[data-conversation-list]").length,
  formSubmits: Array.from(document.querySelectorAll('form button[type="submit"]')).map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10),
  headings: Array.from(document.querySelectorAll("h1,h2,h3,legend,label")).map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 16),
  conformanceIds: Array.from(new Set(Array.from(document.querySelectorAll("[data-conformance-id]")).map((e) => e.getAttribute("data-conformance-id")))).slice(0, 26),
});

const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const out = { slice: PLAN.slice, recordedAt: new Date().toISOString(), records: [] };
for (const cell of PLAN.cells) {
  for (const theme of cell.themes) {
    const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await ctx.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch { /* the record says which theme resolved */ } }, theme);
    const page = await ctx.newPage(); page.setDefaultTimeout(240_000);
    await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
    await page.goto(cell.url.replace(/\$\{([A-Z_]+)\}/g, (_, n) => process.env[n]), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(cell.settleMs ?? 12000);
    for (const a of cell.actions ?? []) {
      if (a.action === "click") await page.click(a.selector, { timeout: 180_000 });
      if (a.action === "waitForSelector") await page.waitForSelector(a.selector, { timeout: 240_000 });
      if (a.action === "waitForTimeout") await page.waitForTimeout(a.ms);
      if (a.action === "scrollIntoView") await page.locator(a.selector).first().scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.waitForTimeout(2500);
    const before = await page.evaluate(READ);
    const shot = `${cell.dir}/${cell.control}__${cell.name}__${theme}.png`;
    mkdirSync(dirname(resolve(shot)), { recursive: true });
    await page.screenshot({ path: shot });
    const after = await page.evaluate(READ);
    const reader = playwrightPage(page);
    const anchors = {};
    for (const sel of cell.anchors ?? []) anchors[sel] = await reader.countVisible(sel);
    const run = (await db.query(`select status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref from cinatra.agent_runs where id=$1`, [process.env.WALK_RUN_ID])).rows[0];
    out.records.push({
      control: cell.control, name: cell.name, theme, url: new URL(page.url()).pathname,
      screenshot: shot, sha256: createHash("sha256").update(readFileSync(shot)).digest("hex"),
      requires: cell.requires, visible: anchors, controlsBeforeTheShutter: before, controlsAfterTheShutter: after,
      dbAtCapture: run, at: new Date().toISOString(),
    });
    console.log(`captured ${cell.control} ${theme} — cards=${JSON.stringify(after.lifecycleCards)} confirmSchedule=${after.confirmScheduleProposal}`);
    await ctx.close();
  }
}
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.records.length} page-control record(s) -> ${OUT}`);
await db.end(); await b.close();
