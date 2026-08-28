// ONE REAL RUN OF THE BLOG-DRAFT-WRITER AGENT, DRIVEN FROM THE CHAT, AND THE
// RUN PAGE PHOTOGRAPHED AT FOUR MOMENTS — cinatra#3047, criterion 4.
//
// WHAT IS MEASURED. Where the skills row is drawn on the run page. At every
// moment the live DOM is read before the shutter: how many
// `[data-lifecycle-card="recommendation_hold"]` roots the page carries, whether
// that root is inside `[data-run-detail-column]`, and whether it is inside
// `[data-run-review-slot]` or `[data-run-progress-panel]` — the box the row must
// not be in, which `agentic-run-panel.tsx` now names so an absence can be
// counted rather than assumed.
//
// NOTHING IS INSERTED. No run, no gate, no park, no record, no review task, no
// status is written by this file. The run is created by the app's own dispatch
// from a sentence typed into the app's own chat, and is found BY DIFFERENCE
// against the runs that existed before. Every chip is decided by pressing the
// chip's OWN affordance ON THE RUN PAGE, and every gate is answered through the
// control the screen itself draws.
//
// THE PALETTE IS THE APP'S OWN. The context is opened with NO colorScheme
// emulation at all — the operating system's `prefers-color-scheme` is left
// exactly as it is and is read back on every frame — so the only thing that can
// darken the page is the header's own "Toggle theme" control, which is pressed.
// Both frames of a pair are taken in the SAME context, at the same moment of the
// same run, without a reload between them.
//
// ONE DISCLOSED ENVIRONMENT ACTION: the dev server's own dev-indicator control
// (`POST /__nextjs_disable_dev_indicator`, what the Next dev toolbar's own
// "hide" affordance calls) so the frames carry no development pill. It is a
// development-toolbar preference; it renders nothing of the product.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";
import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";
import { observeWalkCell } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
const CELLS = process.env.CELLS_DIR;
const SENTENCE = process.env.WALK_SENTENCE;
const SERVER_LOG = process.env.SERVER_LOG;
const SETUP_ANSWER = process.env.WALK_ANSWER ?? "";
const MIDRUN_ANSWER = process.env.WALK_MIDRUN_ANSWER ?? "";
const SLUG = process.env.WALK_AGENT_SLUG ?? "blog-draft-writer-agent";
const REVIEW_WAIT_MS = Number(process.env.WALK_REVIEW_WAIT_MS ?? 1_500_000);
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, OUT_JSON: OUT, CELLS_DIR: CELLS, WALK_SENTENCE: SENTENCE, SERVER_LOG }))
  if (!v) throw new Error(`the run driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
if (!signIn.ok()) { console.log(`FAIL sign-in ${signIn.status()}`); process.exit(1); }
console.log("PASS signed in");

const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.setDefaultNavigationTimeout(600_000);
const timeline = [];
const stamp = (what, extra = {}) => {
  const e = { at: new Date().toISOString(), what, ...extra };
  timeline.push(e);
  console.log(`  · ${e.at} ${what}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`);
  return e;
};

const hid = await context.request.post("/__nextjs_disable_dev_indicator", { headers: { Origin: APP } });
stamp("the development toolbar's own indicator control was used (disclosed environment action)", { status: hid.status() });

// ── THE PALETTE, ON THE APP'S OWN CONTROL ────────────────────────────────────
const readTheme = () => page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  dark: document.documentElement.classList.contains("dark"),
  stored: (() => { try { return window.localStorage.getItem("theme"); } catch { return null; } })(),
  osPrefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  bodyBackground: getComputedStyle(document.body).backgroundColor,
}));
async function ensureTheme(want) {
  for (let i = 0; i < 4; i += 1) {
    const t = await readTheme();
    if (t.dark === (want === "dark")) return t;
    const toggle = page.getByRole("button", { name: /toggle theme/i }).first();
    await toggle.waitFor({ timeout: 120_000 });
    await toggle.click();
    await page.waitForTimeout(2200);
  }
  const t = await readTheme();
  if (t.dark !== (want === "dark")) throw new Error(`the app's own theme control did not reach ${want}`);
  return t;
}

// ── THE MEASUREMENT — read off the LIVE DOM, before every shutter ────────────
const readPlacement = () => page.evaluate(() => {
  const roots = [...document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]')];
  const detailColumn = document.querySelector("[data-run-detail-column]");
  const progressPanels = [...document.querySelectorAll("[data-run-progress-panel]")];
  const reviewSlots = [...document.querySelectorAll("[data-run-review-slot]")];
  const railRows = [...document.querySelectorAll("[data-run-step-rail-column] [data-conformance-id]")]
    .map((e) => (e.innerText ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const per = roots.map((r) => ({
    state: r.getAttribute("data-lifecycle-card-state"),
    host: r.closest("[data-lifecycle-card-host]")?.getAttribute("data-lifecycle-card-host") ?? null,
    insideRunDetailColumn: Boolean(r.closest("[data-run-detail-column]")),
    insideRunReviewSlot: Boolean(r.closest("[data-run-review-slot]")),
    insideRunProgressPanel: Boolean(r.closest("[data-run-progress-panel]")),
    chips: r.querySelectorAll("[data-skill-id]").length,
    confirmAffordances: r.querySelectorAll('[data-skill-action="confirm"]').length,
    outcomeWords: [...r.querySelectorAll("[data-skill-id]")]
      .map((c) => (c.innerText ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
    text: (r.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 320),
  }));
  return {
    rootCount: roots.length,
    roots: per,
    rootsInsideProgressPanel: progressPanels.reduce((n, p) => n + p.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length, 0),
    rootsInsideReviewSlot: reviewSlots.reduce((n, p) => n + p.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length, 0),
    runProgressPanels: progressPanels.length,
    runReviewSlots: reviewSlots.length,
    reviewSlotReading: reviewSlots.map((s) => s.getAttribute("data-run-review-slot")),
    reviewGates: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
    detailColumnPresent: Boolean(detailColumn),
    selectedStep: detailColumn?.getAttribute("data-run-surface-selected-step") ?? null,
    recommendationRailSteps: document.querySelectorAll("[data-recommendation-rail-step]").length,
    recommendationRailStepSelected: document.querySelector("[data-recommendation-rail-step]")?.getAttribute("data-recommendation-step-selected") ?? null,
    recommendationRailStepSettled: document.querySelector("[data-recommendation-rail-step]")?.getAttribute("data-recommendation-step-settled") ?? null,
    railRows,
    devPill: document.querySelectorAll("nextjs-portal, [data-nextjs-dev-tools-button]").length,
    dark: document.documentElement.classList.contains("dark"),
  };
});

const frames = [];
const selectionReadings = [];
const captureRecords = [];
const recorderRefusals = [];

// THE GATE'S OWN CONTINUE. `data-action="submit-hitl-screen"` is on the screen
// card's decision, and the run panel withholds it wherever the row carries a
// Reject beside it — so the anchor is tried first and the control's own visible
// name second. Which one answered is recorded, never assumed.
async function pressTheGatesContinue() {
  const byAnchor = page.locator('[data-action="submit-hitl-screen"]').first();
  if ((await byAnchor.count()) > 0) {
    await byAnchor.scrollIntoViewIfNeeded().catch(() => {});
    await byAnchor.click({ timeout: 120_000 });
    return "data-action=submit-hitl-screen";
  }
  const byName = page.getByRole("button", { name: /^Continue$/ }).first();
  if ((await byName.count()) > 0) {
    await byName.scrollIntoViewIfNeeded().catch(() => {});
    await byName.click({ timeout: 120_000 });
    return "the control's own name, Continue";
  }
  return null;
}

// THE RUN PAGE'S OWN FRAME, waited for rather than assumed. A dev server that
// has already compiled this route paints the agent's own setup screen first and
// swaps in the run's two-column frame a moment later; a shutter fired in that
// window photographs a page that is not the one being measured. So the frame's
// own marker is waited for, and the page reloaded if it does not arrive.
async function waitForRunFrame(runPage, { needRecommendationStep = true } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seen = await page.evaluate(() => ({
      detailColumn: Boolean(document.querySelector("[data-run-detail-column]")),
      recommendationStep: document.querySelectorAll("[data-recommendation-rail-step]").length,
      url: window.location.pathname,
    }));
    if (seen.detailColumn && (!needRecommendationStep || seen.recommendationStep > 0)) {
      stamp("the run page's own two-column frame is on screen", { attempt, ...seen });
      return seen;
    }
    await page.waitForTimeout(6000);
    if (attempt % 2 === 1) { await page.goto(runPage, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(8000); }
  }
  const seen = await page.evaluate(() => ({
    detailColumn: Boolean(document.querySelector("[data-run-detail-column]")),
    recommendationStep: document.querySelectorAll("[data-recommendation-rail-step]").length,
    url: window.location.pathname,
  }));
  stamp("THE RUN FRAME DID NOT ARRIVE — stated, not worked around", seen);
  return seen;
}
async function openRecommendationStep() {
  const step = page.locator("[data-recommendation-rail-step]").first();
  if ((await step.count()) === 0) return false;
  if ((await step.getAttribute("data-recommendation-step-selected")) === "true") return true;
  await step.scrollIntoViewIfNeeded().catch(() => {});
  await step.click({ timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return (await step.getAttribute("data-recommendation-step-selected")) === "true";
}

// One moment, both palettes, in the SAME context and without a reload between
// them: light, then the app's own control, then dark, then the control back.
//
// THE SHUTTER IS THE SHIPPED RECORDER'S. `observeWalkCell` takes the picture,
// counts the contract's own required anchors on the screen it took it of, and
// REFUSES the record if the claim and the screen disagree. A refusal is caught
// and recorded as a finding — it is never worked around, and the moment it
// refuses is not re-photographed under an easier name.
async function shoot(cellBase, moment, state) {
  const pair = [];
  for (const want of ["light", "dark"]) {
    const theme = await ensureTheme(want);
    await page.evaluate(() => { window.scrollTo(0, 0); if (document.scrollingElement) document.scrollingElement.scrollTop = 0; });
    await page.waitForTimeout(1500);
    const observed = await readPlacement();
    const cellName = `${cellBase}__${want}`;
    const shotPath = `${CELLS}/${cellName}.png`;
    const cell = {
      cell: cellName,
      declaredHost: "run_card",
      kind: "recommendation_hold",
      state,
      screenshot: shotPath,
      build: "development",
      framing: "window",
    };
    let record = null;
    let refusal = null;
    try {
      record = await observeWalkCell({ page: playwrightPage(page), cell, repoRoot: process.cwd() });
      captureRecords.push(record);
    } catch (err) {
      refusal = String(err?.message ?? err);
      recorderRefusals.push({ cell: cellName, refusal });
      stamp("THE SHIPPED RECORDER REFUSED THIS RECORD — the refusal is the finding", { cell: cellName, refusal: refusal.slice(0, 400) });
    }
    const rec = { cell: cellName, moment, state, theme: want, path: shotPath, at: new Date().toISOString(), themeReading: theme, observed, recorded: Boolean(record), refusal };
    pair.push(rec);
    frames.push(rec);
    stamp(`photographed ${cellName}`, { roots: observed.rootCount, inDetail: observed.roots.map((r) => r.insideRunDetailColumn), inProgressPanel: observed.rootsInsideProgressPanel, selectedStep: observed.selectedStep, recorded: Boolean(record) });
  }
  await ensureTheme("light");
  return pair;
}

const send = async (text) => {
  await page.click('div[contenteditable="true"][role="textbox"]');
  await page.type('div[contenteditable="true"][role="textbox"]', text, { delay: 8 });
  await page.keyboard.press("Enter");
};
const assistantTurns = async () => Number((await db.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role='assistant'")).rows[0].n);
async function waitForAssistantTurn(before, maxTicks = 150) {
  for (let i = 0; i < maxTicks; i += 1) {
    if ((await assistantTurns()) > before) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');
stamp("the theme BEFORE anything was pressed", await readTheme());

// A WARM-UP TURN, DISCLOSED — the runtime HEADs the public MCP URL and refuses
// the turn outright if the ingress does not answer, so a refused probe is an
// ENVIRONMENT fact and is COUNTED rather than hidden.
let refusals = 0;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const warmBefore = await assistantTurns();
  await send("Hello — are your platform tools available?");
  await waitForAssistantTurn(warmBefore);
  await page.waitForTimeout(8000);
  const last = (await db.query("SELECT content::text AS c FROM cinatra.assistant_turns WHERE role='assistant' ORDER BY created_at DESC LIMIT 1")).rows[0];
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
for (let i = 0; i < 200; i += 1) {
  const rows = (await db.query("SELECT id, status, created_at FROM cinatra.agent_runs ORDER BY created_at DESC")).rows;
  const fresh = rows.filter((r) => !runsBefore.includes(r.id));
  if (fresh.length > 0) { run = fresh[0]; break; }
  await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no run was created by the app's own dispatch"); await browser.close(); process.exit(1); }
const RUN = run.id;
const RUN_PAGE = `/agents/cinatra-ai/${SLUG}/${RUN}`;
stamp("the app's own dispatch created the run", { runId: RUN, status: run.status, runPage: RUN_PAGE });
const runRow = async () => (await db.query("SELECT id, status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, error FROM cinatra.agent_runs WHERE id=$1", [RUN])).rows[0];

// ── MOMENT 1 — THE RECOMMENDATION, HELD, ON THE RUN PAGE ────────────────────
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-lifecycle-card="recommendation_hold"]', { timeout: 600_000 });
await page.waitForTimeout(9000);
stamp("the run parked on the recommendation", await runRow());
await waitForRunFrame(RUN_PAGE);
const opened = await openRecommendationStep();
stamp("the recommendation rail step is the open step", { opened });
const heldPair = await shoot("P1__recommendation-card__run_card__held__rail-step", "recommendation (held)", "pending");

// ── THE FOUR CHIPS, EACH ON ITS OWN AFFORDANCE, ON THE RUN PAGE ─────────────
const skillIds = await page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="recommendation_hold"]');
  return card ? [...card.querySelectorAll('[data-skill-action="confirm"]')].map((e) => e.getAttribute("data-skill-id")) : [];
});
stamp("the held row drew one chip per assigned skill", { chips: skillIds.length, skillIds });
const PLAN = ["confirm", "adjust", "confirm", "skip"];
const decisions = [];
for (let i = 0; i < skillIds.length; i += 1) {
  const id = skillIds[i];
  const action = PLAN[i] ?? "confirm";
  const use = page.locator(`[data-skill-action="${action}"][data-skill-id="${id}"]`).first();
  if ((await use.count()) === 0) { stamp("NO affordance of that name on this chip", { skillId: id, action }); continue; }
  await use.scrollIntoViewIfNeeded().catch(() => {});
  await use.click({ timeout: 120_000 });
  await page.waitForTimeout(3500);
  if (action === "adjust") {
    const keep = page.locator(`[data-skill-action="adjust-keep"][data-skill-id="${id}"]`).first();
    if ((await keep.count()) > 0) { await keep.scrollIntoViewIfNeeded().catch(() => {}); await keep.click({ timeout: 120_000 }); await page.waitForTimeout(3500); }
    else stamp("NO adjust-keep affordance appeared for this chip", { skillId: id });
  }
  decisions.push({ skillId: id, pressed: action });
  stamp("a chip was settled on its own affordance, on the run page", { skillId: id, pressed: action });
}
await page.waitForTimeout(9000);

// ── MOMENT 2 — THE HITL SETUP MOMENT, WITH THE ROW SETTLED ──────────────────
for (let i = 0; i < 300; i += 1) {
  const r = await runRow();
  if (r.status === "pending_approval") { stamp("the run parked at its setup gate", r); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("terminal before the setup park", r); break; }
  await page.waitForTimeout(2000);
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(12_000);
await waitForRunFrame(RUN_PAGE);
// THE PAGE'S OWN READING — no rail row is pressed, so the run detail is what the
// screen itself opens on: the row, and the moment's own surface beneath it.
const hitlPair = await shoot("P2__recommendation-card__run_card__decided__setup-gate", "HITL setup (settled row)", "decided");
// AND THE STEP, SELECTED — criterion 2's "selecting it opens the row without a
// second instance", read rather than photographed.
await openRecommendationStep();
selectionReadings.push({ moment: "HITL setup", ...(await readPlacement()) });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(12_000);

// the setup gate, answered through the screen's own control
const fields = page.locator('[data-conformance-id="hitl-screen-fields"]');
if ((await fields.count()) > 0) {
  const box = fields.locator("textarea, input[type='text'], input:not([type])").first();
  if (SETUP_ANSWER && (await box.count()) > 0) await box.fill(SETUP_ANSWER).catch(() => {});
  const pressed = await pressTheGatesContinue();
  stamp(pressed ? "the setup gate was answered through the screen's own Continue" : "NO CONTINUE on the setup screen", { by: pressed });
} else stamp("NO HITL SCREEN FIELDS on the run page at the setup park");

// ── MOMENT 4 — THE SCHEDULE MOMENT ──────────────────────────────────────────
for (let i = 0; i < 300; i += 1) {
  const r = await runRow();
  if (r.status === "pending_trigger") { stamp("the run reached the schedule moment", r); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("terminal before the schedule moment", r); break; }
  await page.waitForTimeout(3000);
}
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(14_000);
await waitForRunFrame(RUN_PAGE);
const schedulePair = await shoot("P4__recommendation-card__run_card__decided__scheduling", "schedule", "decided");
await openRecommendationStep();
selectionReadings.push({ moment: "schedule", ...(await readPlacement()) });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(12_000);

const submit = page.locator('form button[type="submit"]').filter({ hasText: /continue|start|run/i }).first();
if ((await submit.count()) === 0) stamp("NO schedule submit on the run page", { buttons: (await page.locator("button").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25) });
else {
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  const label = (await submit.textContent())?.replace(/\s+/g, " ").trim();
  await submit.click();
  stamp("the run page's own scheduling step armed the run", { label });
}

// the mid-run gate, answered through the screen's own Continue
const gatesOf = async () => (await db.query("SELECT review_task_id, field_name, x_renderer, created_at FROM cinatra.agent_run_hitl_gates WHERE run_id=$1 ORDER BY created_at", [RUN])).rows;
for (let i = 0; i < 300; i += 1) {
  const r = await runRow();
  const gs = await gatesOf();
  if (r.status === "pending_approval" && gs.length > 1) {
    stamp("the mid-run gate opened", gs[gs.length - 1]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(12_000);
    const f = page.locator('[data-conformance-id="hitl-screen-fields"]').first();
    const box = f.locator("textarea, input[type='text'], input:not([type])").first();
    if ((await box.count()) > 0 && MIDRUN_ANSWER) await box.fill(MIDRUN_ANSWER).catch(() => {});
    const pressed = await pressTheGatesContinue();
    stamp(pressed ? "the mid-run gate was answered through the screen's own Continue" : "NO CONTINUE on the mid-run screen", { by: pressed });
    break;
  }
  if (["failed", "cancelled", "completed"].includes(r.status)) { stamp("terminal before any mid-run gate", r); break; }
  await page.waitForTimeout(4000);
}

// ── MOMENT 3 — THE REVIEW MOMENT ────────────────────────────────────────────
const reviewGate = async () => (await db.query("SELECT id, review_task_id, status, created_at FROM cinatra.artifact_review_gates WHERE run_id=$1 ORDER BY created_at", [RUN])).rows;
let gateRow = null;
const t0 = Date.now();
while (Date.now() - t0 < REVIEW_WAIT_MS) {
  const gs = await reviewGate();
  if (gs.length > 0) { gateRow = gs[gs.length - 1]; stamp("THE ARTIFACT REVIEW GATE IS ON FILE", gateRow); break; }
  const r = await runRow();
  if (["failed", "cancelled"].includes(r.status)) { stamp("the run reached a terminal status with no review gate", r); break; }
  await page.waitForTimeout(4000);
}
let reviewPair = null;
if (gateRow) {
  await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(16_000);
  await waitForRunFrame(RUN_PAGE);
  reviewPair = await shoot("P3__recommendation-card__run_card__decided__awaiting-decision", "review (settled row)", "decided");
  await openRecommendationStep();
  selectionReadings.push({ moment: "review", ...(await readPlacement()) });
}

const finalRun = await runRow();
const gates = await gatesOf();
const rg = await reviewGate();
const tail = (() => { try { return readFileSync(SERVER_LOG, "utf8").slice(startOffset); } catch { return ""; } })();
const out = {
  runId: RUN,
  runPage: RUN_PAGE,
  threadUrl,
  finalRun,
  decisions,
  skillIds,
  hitlGates: gates,
  reviewGates: rg,
  frames,
  selectionReadings,
  captureRecords,
  recorderRefusals,
  pairs: { recommendationHeld: heldPair, hitlSettled: hitlPair, schedule: schedulePair, review: reviewPair },
  ingressRefusalsBeforeTheMeasuredTurn: refusals,
  serverLogMarkers: {
    scriptedProviderLines: (tail.match(/CINATRA_TEST_LLM_PROVIDER|scripted-llm|ScriptedProvider/g) ?? []).length,
    llmBridgeRunSelect: (tail.match(/\[llm-bridge-run-select\]/g) ?? []).length,
    publicMcpCallbacks: (tail.match(/POST \/api\/mcp 200/g) ?? []).length,
  },
  timeline,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ runId: RUN, status: finalRun.status, frames: frames.length, reviewGate: Boolean(gateRow) }, null, 1));
await db.end();
await browser.close();
