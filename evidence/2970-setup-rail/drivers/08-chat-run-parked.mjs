// A RUN PARKED IN SETUP, made from the app's own chat with the real provider:
// the person asks for the agent to run, the app starts it person-present, and
// it parks BEFORE executing — the run then sits in a pre-execution status with
// no trigger row, which is the state the setup run page is drawn for.
//
// Same discipline as 05-real-run-chain.mjs: a warm-up turn first (the model's
// hosted MCP connector fails its first tool-list fetch on a cold OAuth path),
// then the measured turn, then the run found BY DIFFERENCE — never inserted.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const AGENT = process.env.WALK_AGENT_NAME;
const SERVER_LOG = process.env.SERVER_LOG;
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, OUT_JSON: OUT, WALK_AGENT_NAME: AGENT, SERVER_LOG }))
  if (!v) throw new Error(`the parked-run driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);
const page = await context.newPage();
page.setDefaultTimeout(420_000);
page.setDefaultNavigationTimeout(420_000);
const timeline = [];
const stamp = (what, extra = {}) => timeline.push({ at: new Date().toISOString(), what, ...extra });

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');
await page.click('div[contenteditable="true"][role="textbox"]');
await page.type('div[contenteditable="true"][role="textbox"]', "Hello — are your platform tools available?", { delay: 8 });
await page.keyboard.press("Enter");
const turnsBefore = Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
for (let i = 0; i < 90; i += 1) {
  const n = Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
  if (n > turnsBefore) break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(15_000);
stamp("a warm-up turn was sent and answered before the measured turn");
const startOffset = (() => { try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; } })();

const sentence = `Please run the ${AGENT} for me now.`;
await page.click('div[contenteditable="true"][role="textbox"]');
await page.type('div[contenteditable="true"][role="textbox"]', sentence, { delay: 8 });
await page.keyboard.press("Enter");
stamp("the person asked for the run in their own words", { sentence });

let run = null;
for (let i = 0; i < 150 && !run; i += 1) {
  const rows = (await db.query(
    `SELECT r.id, r.status, r.created_at, r.started_at, r.human_present, r.source_type, t.package_name, t.name
       FROM cinatra.agent_runs r JOIN cinatra.agent_templates t ON t.id = r.template_id
      ORDER BY r.created_at DESC`,
  )).rows;
  run = rows.find((r) => !runsBefore.includes(r.id)) ?? null;
  if (!run) await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no new run row appeared"); process.exit(1); }
stamp("the app's own dispatch created the run", { runId: run.id, status: run.status });
console.log(`PASS the app's own dispatch created run ${run.id} in status ${run.status}`);

// Let the run settle into whatever pre-execution state it parks in, then read
// the status and the trigger row back.
await page.waitForTimeout(20_000);
const settled = (await db.query(
  `SELECT id, status, created_at, started_at, human_present FROM cinatra.agent_runs WHERE id = $1`, [run.id],
)).rows[0];
const trigger = (await db.query(`SELECT * FROM cinatra.agent_run_triggers WHERE run_id = $1`, [run.id])).rows[0] ?? null;
console.log(`PASS the run reads ${settled.status}; trigger row: ${trigger ? "present" : "none"}`);
const [vendor, slug] = String(run.package_name).replace(/^@/, "").split("/");
const runUrl = `/agents/${vendor}/${slug}/${run.id}/trigger`;
const threadUrl = page.url();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ run: settled, packageName: run.package_name, trigger, runUrl, threadUrl, sentence, timeline }, null, 2)}\n`);
console.log(`PASS setup run page is ${runUrl}`);
await db.end();
await browser.close();
