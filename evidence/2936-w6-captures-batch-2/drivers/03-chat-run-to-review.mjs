// THE RUN, STARTED FROM THE APP'S OWN CHAT AND DRIVEN TO ITS ARTIFACT REVIEW.
//
// The person asks for the agent in their own words; the app's own dispatch
// creates the run; every decision after that is taken by pressing what the
// screens themselves draw — the four chips' own affordances, the setup card's
// own Continue, the run page's own schedule Continue ("Run right after setup",
// because the schedule card does not reach the chat on this head — a KNOWN,
// RECORDED defect from batch 1, not re-attempted here), and the mid-run gate's
// own Continue.
//
// IT ALSO MEASURES THE PLACEHOLDER WINDOW (cards §II / review §I, "one slot,
// two readings"): from the moment the mid-run gate is answered to the moment
// the artifact review gate is on file, this driver polls the run page's own
// slot marker `data-run-review-slot` and photographs the WORKING reading in
// both themes if the timing allows it. Never a stand-in: when the window is
// too short to photograph, the window itself is recorded, measured.
//
// NOTHING IS INSERTED. No run, no gate, no park, no record, no review task, no
// status. The run is found BY DIFFERENCE against the rows that existed before,
// and every number is read back from the rows.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const SENTENCE = process.env.WALK_SENTENCE;
const SERVER_LOG = process.env.SERVER_LOG;
const SETUP_ANSWER = process.env.WALK_ANSWER ?? "";
const CELLS = process.env.WALK_CELL_DIR;
const REVIEW_WAIT_MS = Number(process.env.WALK_REVIEW_WAIT_MS ?? 1200000);
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, OUT_JSON: OUT, WALK_SENTENCE: SENTENCE, SERVER_LOG, WALK_CELL_DIR: CELLS }))
  if (!v) throw new Error(`the chat-run driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

const browser = await chromium.launch();
const mk = (scheme) => browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
const context = await mk("light");
const signIn = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.setDefaultNavigationTimeout(600_000);
const timeline = [];
const stamp = (what, extra = {}) => { const e = { at: new Date().toISOString(), what, ...extra }; timeline.push(e); console.log(`  · ${e.at} ${what}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`); };

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');
const send = async (text) => {
  await page.click('div[contenteditable="true"][role="textbox"]');
  await page.type('div[contenteditable="true"][role="textbox"]', text, { delay: 8 });
  await page.keyboard.press("Enter");
};
const assistantTurns = async () =>
  Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
async function waitForAssistantTurn(before, maxTicks = 150) {
  for (let i = 0; i < maxTicks; i += 1) {
    if ((await assistantTurns()) > before) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

// A WARM-UP TURN, DISCLOSED. The runtime HEADs the public MCP URL with a narrow
// budget and refuses the turn outright if the ingress does not answer, so a
// refused turn is an ENVIRONMENT fact and is counted rather than hidden.
let refusals = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const warmBefore = await assistantTurns();
  await send("Hello — are your platform tools available?");
  await waitForAssistantTurn(warmBefore);
  await page.waitForTimeout(8_000);
  const last = (await db.query(
    "SELECT content::text AS c FROM cinatra.assistant_turns WHERE role='assistant' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const refused = /not reachable|tools are unavailable/i.test(String(last?.c ?? ""));
  if (!refused) { stamp("a warm-up (probe) turn was answered with the platform's tools available", { attempt, refusalsSoFar: refusals }); break; }
  refusals += 1;
  stamp("the ingress REFUSED the probe turn — an environment fact, not a product reading", { attempt });
  await page.waitForTimeout(10_000);
}
stamp("ingress refusals before the measured turn", { refusals });
const startOffset = (() => { try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; } })();

stamp("the person asked for the run in their own words", { sentence: SENTENCE });
const measuredBefore = await assistantTurns();
await send(SENTENCE);
await waitForAssistantTurn(measuredBefore);
const threadUrl = new URL(page.url()).pathname;
stamp("the dispatch turn settled in the conversation", { threadUrl });

let run = null;
for (let i = 0; i < 180; i += 1) {
  const rows = (await db.query(
    `SELECT id, status, created_at, template_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref
       FROM cinatra.agent_runs ORDER BY created_at DESC`)).rows;
  const fresh = rows.filter((r) => !runsBefore.includes(r.id));
  if (fresh.length > 0) { run = fresh[0]; break; }
  await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no run was created by the app's own dispatch"); await browser.close(); process.exit(1); }
stamp("the app's own dispatch created the run", { runId: run.id, status: run.status });
const RUN = run.id;
const runRow = async () => (await db.query(
  `SELECT id, status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, error
     FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0];

// The four chips, each CONFIRMED on its own affordance.
await page.waitForSelector('[data-lifecycle-card="recommendation_hold"]', { timeout: 300_000 });
await page.waitForTimeout(9000);
const skillIds = await page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="recommendation_hold"]');
  return card ? Array.from(card.querySelectorAll('[data-skill-action="confirm"]')).map((e) => e.getAttribute("data-skill-id")) : [];
});
stamp("the hold drew one chip per assigned skill", { chips: skillIds.length, skillIds });
for (const id of skillIds) {
  const control = page.locator(`[data-skill-action="confirm"][data-skill-id="${id}"]`).first();
  await control.scrollIntoViewIfNeeded().catch(() => {});
  await control.click();
  await page.waitForTimeout(4000);
}
await page.waitForTimeout(10000);
const settled = await page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="recommendation_hold"]');
  return card ? { state: card.getAttribute("data-lifecycle-card-state"), confirm: card.querySelectorAll('[data-skill-action="confirm"]').length } : null;
});
stamp("the row settled on the card's own affordances", settled ?? {});

// The setup gate, answered ON THE CARD.
for (let i = 0; i < 240; i += 1) {
  const r = await runRow();
  if (r.status === "pending_approval") { stamp("the run parked", { status: r.status, moment: r.lifecycle_moment, kind: r.lifecycle_card_kind }); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("the run reached a terminal status before the setup park", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(5000);
const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
if ((await fields.count()) > 0) {
  const box = fields.locator("textarea, input[type='text'], input:not([type])").first();
  if (SETUP_ANSWER && (await box.count()) > 0) await box.fill(SETUP_ANSWER).catch(() => {});
  const cont = page.locator('[data-action="submit-hitl-screen"]').first();
  if ((await cont.count()) > 0) { await cont.scrollIntoViewIfNeeded().catch(() => {}); await cont.click({ timeout: 120000 }); stamp("the setup gate was answered through the card's own Continue"); }
  else stamp("NO CONTINUE on the setup card — it submits on change");
} else stamp("NO HITL SCREEN CARD in the conversation at the park");

// The schedule moment: RUN RIGHT AFTER SETUP, pressed on the run page's own
// scheduling step. Batch 1 recorded that the schedule card never reaches the
// conversation on this head; that defect is not re-attempted here.
for (let i = 0; i < 240; i += 1) {
  const r = await runRow();
  if (r.status === "pending_trigger") { stamp("the run reached the schedule moment", { status: r.status, moment: r.lifecycle_moment, kind: r.lifecycle_card_kind, ref: r.lifecycle_card_ref }); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("terminal before the schedule moment", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(3000);
}
const RUN_PAGE = `/agents/cinatra-ai/${process.env.WALK_AGENT_SLUG ?? "blog-draft-writer-agent"}/${RUN}`;
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(15000);
const submit = page.locator('form button[type="submit"]').filter({ hasText: /continue|start|run/i }).first();
if ((await submit.count()) === 0) {
  stamp("NO schedule submit on the run page", { buttons: (await page.locator("button").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25) });
} else {
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  const label = (await submit.textContent())?.replace(/\s+/g, " ").trim();
  await submit.click();
  stamp("the run page's own scheduling step armed the run", { label });
}

// The mid-run gate, answered through the card's own Continue on the run page.
let midrunAnsweredAt = null;
const gatesOf = async () => (await db.query(
  `SELECT review_task_id, field_name, x_renderer, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
for (let i = 0; i < 300; i += 1) {
  const r = await runRow();
  const gs = await gatesOf();
  if (r.status === "pending_approval" && gs.length > 1) {
    stamp("the mid-run gate opened", { reviewTaskId: gs[gs.length - 1].review_task_id, renderer: gs[gs.length - 1].x_renderer });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(12000);
    const cont = page.locator('[data-action="submit-hitl-screen"]').first();
    if ((await cont.count()) > 0) {
      const f = page.locator('[data-conformance-id="hitl-screen-fields"]').first();
      const box = f.locator("textarea, input[type='text'], input:not([type])").first();
      if ((await box.count()) > 0 && process.env.WALK_MIDRUN_ANSWER) await box.fill(process.env.WALK_MIDRUN_ANSWER).catch(() => {});
      await cont.scrollIntoViewIfNeeded().catch(() => {});
      await cont.click({ timeout: 120000 });
      midrunAnsweredAt = new Date().toISOString();
      stamp("the mid-run gate was answered through the card's own Continue");
    } else stamp("NO CONTINUE on the mid-run card");
    break;
  }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("terminal before any mid-run gate", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(4000);
}

// ── THE PLACEHOLDER WINDOW ────────────────────────────────────────────────
// From here the run works and the slot holds the placeholder; when the artifact
// review gate is minted the SAME slot holds the review. Both readings are
// polled off the run page's own `data-run-review-slot` marker, and the window
// between them is measured whether or not it is long enough to photograph.
const darkCtx = await mk("dark");
await darkCtx.addCookies(await context.cookies());
const darkPage = await darkCtx.newPage();
darkPage.setDefaultTimeout(600_000);
await darkPage.goto(RUN_PAGE, { waitUntil: "domcontentloaded" }).catch(() => {});

const reviewGate = async () => (await db.query(
  `SELECT id, review_task_id, status, created_at FROM cinatra.artifact_review_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
const slotOf = async (p) => p.evaluate(() => {
  const s = document.querySelector("[data-run-review-slot]");
  return s
    ? { slot: s.getAttribute("data-run-review-slot"), placeholder: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length, gate: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length }
    : { slot: null, placeholder: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length, gate: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length };
}).catch(() => ({ slot: null, placeholder: 0, gate: 0 }));

mkdirSync(CELLS, { recursive: true });
const windowLog = [];
let placeholderShots = { light: null, dark: null };
let firstWorkingAt = null, gateSeenAt = null, gateRow = null;
const t0 = Date.now();
while (Date.now() - t0 < REVIEW_WAIT_MS) {
  const [l, d] = await Promise.all([slotOf(page), slotOf(darkPage)]);
  const gs = await reviewGate();
  const now = new Date().toISOString();
  windowLog.push({ at: now, light: l, dark: d, reviewGates: gs.length });
  if (l.slot === "working" && l.placeholder > 0) {
    if (!firstWorkingAt) { firstWorkingAt = now; stamp("THE SLOT IS DRAWING THE PLACEHOLDER", { light: l, dark: d }); }
    if (!placeholderShots.light) { const p = `${CELLS}/P1__run-progress-placeholder__run_card__light.png`; await page.screenshot({ path: p }); placeholderShots.light = { path: p, at: now, observed: l }; }
  }
  if (d.slot === "working" && d.placeholder > 0 && !placeholderShots.dark) {
    const p = `${CELLS}/P1__run-progress-placeholder__run_card__dark.png`; await darkPage.screenshot({ path: p }); placeholderShots.dark = { path: p, at: new Date().toISOString(), observed: d };
  }
  if (gs.length > 0) { gateSeenAt = now; gateRow = gs[gs.length - 1]; stamp("THE ARTIFACT REVIEW GATE IS ON FILE", { reviewTaskId: gateRow.review_task_id, status: gateRow.status, createdAt: gateRow.created_at }); break; }
  const r = await runRow();
  if (["failed", "cancelled"].includes(r.status)) { stamp("the run reached a terminal status with no review gate", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(1500);
}
await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(10000);
const afterSlot = await slotOf(page);
stamp("the slot after the mint", afterSlot);

const finalRun = await runRow();
const gates = await gatesOf();
const rg = await reviewGate();
const tail = (() => { try { return readFileSync(SERVER_LOG, "utf8").slice(startOffset); } catch { return ""; } })();
const out = {
  runId: RUN,
  threadUrl,
  runPage: RUN_PAGE,
  finalRun,
  hitlGates: gates,
  reviewGates: rg,
  reviewTaskId: rg.length ? rg[rg.length - 1].review_task_id : null,
  midrunAnsweredAt,
  placeholderWindow: {
    firstWorkingReadingAt: firstWorkingAt,
    reviewGateOnFileAt: gateSeenAt,
    reviewGateCreatedAt: gateRow?.created_at ?? null,
    measuredWindowMs: firstWorkingAt && gateSeenAt ? Date.parse(gateSeenAt) - Date.parse(firstWorkingAt) : null,
    shots: placeholderShots,
    samples: windowLog.length,
    log: windowLog,
  },
  slotAfterTheMint: afterSlot,
  timeline,
  serverLogMarkers: {
    scriptedProviderLines: (tail.match(/CINATRA_TEST_LLM_PROVIDER|scripted-llm|ScriptedProvider/g) ?? []).length,
    llmBridgeRunSelect: (tail.match(/\[llm-bridge-run-select\]/g) ?? []).length,
    publicMcpCallbacks: (tail.match(/POST \/api\/mcp 200/g) ?? []).length,
    probeRefusalsBeforeTheMeasuredTurn: refusals,
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ runId: RUN, threadUrl, runPage: RUN_PAGE, status: finalRun.status, reviewTaskId: out.reviewTaskId, windowMs: out.placeholderWindow.measuredWindowMs, shots: Object.fromEntries(Object.entries(placeholderShots).map(([k, v]) => [k, Boolean(v)])) }, null, 1));
await db.end();
await browser.close();
