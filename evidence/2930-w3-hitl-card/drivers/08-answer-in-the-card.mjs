// ANSWER THE QUESTION IN THE CARD, in the conversation the run was started
// from — the cookie host — and read the run back out of the database.
//
// The answer is typed into the field the card draws and the card's own control
// is pressed. Nothing is submitted through an API by this driver, and no row is
// written by it: the app's own approval core does the write.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const RUN = process.env.WALK_RUN_ID;
const THREAD_URL = process.env.WALK_THREAD_URL;
const ANSWER = process.env.WALK_ANSWER;
const OUT = process.env.OUT_JSON;
const SHOT_LIGHT = process.env.SHOT_LIGHT;
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, WALK_RUN_ID: RUN, WALK_THREAD_URL: THREAD_URL, WALK_ANSWER: ANSWER, OUT_JSON: OUT, SHOT_LIGHT }))
  if (!v) throw new Error(`the answer driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const readRun = async () => (await db.query(
  `SELECT id, status, started_at, completed_at, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params, a2a_task_id, now() AS read_at FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0];
const readGates = async () => (await db.query(
  `SELECT review_task_id, x_renderer, field_name, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;

const before = { run: await readRun(), gates: await readGates() };
console.log(`BEFORE status=${before.run.status} input_params=${before.run.input_params} moment=${before.run.lifecycle_moment}`);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
await context.addInitScript(() => { try { window.localStorage.setItem("theme", "light"); } catch { /* the record says which theme resolved */ } });
const si = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
const page = await context.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);
await page.goto(THREAD_URL, { waitUntil: "domcontentloaded" });
const cardRoot = page.locator('[data-conformance-id="agent-hitl-screen-card"]');
await cardRoot.first().waitFor({ timeout: 300_000 });
await page.waitForTimeout(5000);

// TYPE THE ANSWER INTO THE FIELD THE CARD DRAWS.
const field = cardRoot.first().locator('textarea, input[type="text"], input:not([type])').first();
await field.click();
await field.fill(ANSWER);
await page.waitForTimeout(1200);
const typedAt = new Date().toISOString();

// PRESS THE CARD'S OWN CONTROL.
const control = cardRoot.first().getByRole("button", { name: /continue/i }).first();
const controlText = (await control.textContent()) ?? "";
const pressedAt = new Date().toISOString();
await control.click();
console.log(`pressed "${controlText.trim()}" inside the card at ${pressedAt}`);

// The card re-reads after every completed attempt; wait for the run to move.
let after = null;
for (let i = 0; i < 120; i += 1) {
  const r = await readRun();
  if (r.status !== before.run.status) { after = r; break; }
  await page.waitForTimeout(1000);
}
after = after ?? (await readRun());
console.log(`AFTER status=${after.status} input_params=${after.input_params}`);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 9000));

mkdirSync(dirname(resolve(SHOT_LIGHT)), { recursive: true });
await page.screenshot({ path: SHOT_LIGHT, fullPage: false });
const settledAt = new Date().toISOString();
const measured = await page.evaluate(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const painted = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return {
    hitlCards: q('[data-lifecycle-card="agent_hitl_screen"]').length,
    hitlCardsPainted: q('[data-lifecycle-card="agent_hitl_screen"]').filter(painted).length,
    anyLifecycleCards: q("[data-lifecycle-card]").map((e) => e.getAttribute("data-lifecycle-card")),
    fieldsRegions: q('[data-conformance-id="hitl-screen-fields"]').length,
    conversationList: q("[data-conversation-list]").length,
    transcriptText: (document.querySelector("[data-conversation-list]")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
    url: location.pathname,
    resolvedTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  };
});
await browser.close();
const finalRun = await readRun();
const gates = await readGates();
await db.end();
const out = { runId: RUN, typedAt, pressedAt, settledAt, controlText: controlText.trim(), answer: ANSWER, before, after, final: finalRun, gates, measured, screenshot: SHOT_LIGHT };
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ before: before.run.status, after: after.status, final: finalRun.status, params: finalRun.input_params, cardsAfter: measured.hitlCards }, null, 2));
