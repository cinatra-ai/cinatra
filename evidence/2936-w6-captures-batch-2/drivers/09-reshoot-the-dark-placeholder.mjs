// THE DARK SIBLING OF THE PLACEHOLDER, RE-SHOT — the one picture this batch got
// wrong.
//
// WHAT WENT WRONG THE FIRST TIME. `03-chat-run-to-review.mjs` opened its second
// browser context with Playwright's `colorScheme: "dark"`, which emulates the
// OPERATING SYSTEM's `prefers-color-scheme` and nothing else. This app does not
// read that: `src/app/providers.tsx` mounts next-themes as
// `<ThemeProvider attribute="class" defaultTheme="cinatra" themes={["cinatra","dark"]}>`,
// so the theme is a CLASS on <html> chosen by the app's own control
// (`src/components/theme-switch.tsx`, the header's "Toggle theme" button) and
// persisted by next-themes; an unset preference resolves to `cinatra` — the
// light palette — whatever the OS says. The context therefore rendered LIGHT and
// the file filed as the dark sibling was a light frame (mean luminance 238/255
// against 17/255 for this batch's real dark frames).
//
// WHAT THIS DRIVER DOES INSTEAD. One context, with NO colorScheme emulation at
// all, so the ONLY thing that can make the page dark is the app's own control:
// the header's "Toggle theme" button is PRESSED, and the class on <html> and
// next-themes' own stored value are read back before anything else happens.
// The theme is switched BEFORE the run starts, because the placeholder window
// measured on this head is 7-18 s wide — too short to switch inside.
//
// Everything else is `03-chat-run-to-review.mjs`: the same real provider through
// the same real public-MCP toolbox, the same warm-up probe, the run created by
// the app's own dispatch and driven only by pressing what the screens draw, and
// the same sampling of the run page's own `data-run-review-slot` marker — one
// element, two readings, timestamped either side.
//
// ONE DISCLOSED ENVIRONMENT ACTION: the dev server's own dev-indicator control
// (`POST /__nextjs_disable_dev_indicator`, the endpoint the Next dev toolbar's
// own "hide" affordance calls) is used so the frame carries no development
// "Rendering…" pill. It is a development-toolbar preference on the dev server;
// it renders nothing of the product and changes no product code.
//
// NOTHING IS INSERTED. No run, no gate, no park, no record, no review task, no
// status. The run is found BY DIFFERENCE against the rows that existed before.
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
const CELL = process.env.WALK_CELL_PATH;
const REVIEW_WAIT_MS = Number(process.env.WALK_REVIEW_WAIT_MS ?? 1200000);
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, OUT_JSON: OUT, WALK_SENTENCE: SENTENCE, SERVER_LOG, WALK_CELL_PATH: CELL }))
  if (!v) throw new Error(`the dark-placeholder driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

const browser = await chromium.launch();
// NO colorScheme: the OS preference is left exactly as it is, so the only thing
// that can darken this page is the app's own theme control.
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.setDefaultNavigationTimeout(600_000);
const timeline = [];
const stamp = (what, extra = {}) => { const e = { at: new Date().toISOString(), what, ...extra }; timeline.push(e); console.log(`  · ${e.at} ${what}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`); };

// The dev toolbar's own hide control, so the frame carries no development pill.
const hid = await context.request.post("/__nextjs_disable_dev_indicator", { headers: { Origin: APP } });
stamp("the development toolbar's own indicator control was used (disclosed environment action)", { status: hid.status() });

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');

// ── THE THEME, THROUGH THE APP'S OWN CONTROL ──────────────────────────────
const readTheme = () => page.evaluate(() => ({
  htmlClass: document.documentElement.className,
  dark: document.documentElement.classList.contains("dark"),
  stored: (() => { try { return window.localStorage.getItem("theme"); } catch { return null; } })(),
  osPrefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  bodyBackground: getComputedStyle(document.body).backgroundColor,
}));
const themeBefore = await readTheme();
stamp("the theme BEFORE the control was pressed", themeBefore);
const toggle = page.getByRole("button", { name: /toggle theme/i }).first();
await toggle.waitFor();
await toggle.click();
await page.waitForTimeout(2500);
let themeAfter = await readTheme();
if (!themeAfter.dark) { await toggle.click(); await page.waitForTimeout(2500); themeAfter = await readTheme(); }
stamp("the theme AFTER the app's own control was pressed", themeAfter);
if (!themeAfter.dark) { console.log("FAIL the app's own theme control did not reach the dark palette"); await browser.close(); process.exit(1); }
console.log("PASS the dark palette is the app's own, switched on the app's own control, with the OS preference untouched");

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

// A WARM-UP TURN, DISCLOSED — the runtime HEADs the public MCP URL and refuses
// the turn outright if the ingress does not answer, so a refused turn is an
// ENVIRONMENT fact and is counted rather than hidden.
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
// scheduling step (batch 1's schedule-card defect is not re-attempted here).
for (let i = 0; i < 240; i += 1) {
  const r = await runRow();
  if (r.status === "pending_trigger") { stamp("the run reached the schedule moment", { status: r.status, moment: r.lifecycle_moment, kind: r.lifecycle_card_kind, ref: r.lifecycle_card_ref }); break; }
  if (["failed", "completed", "cancelled"].includes(r.status)) { stamp("terminal before the schedule moment", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(3000);
}
const RUN_PAGE = `/agents/cinatra-ai/${process.env.WALK_AGENT_SLUG ?? "blog-draft-writer-agent"}/${RUN}`;
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(15000);
stamp("the theme as the RUN PAGE reads it", await readTheme());
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
  if (["failed", "cancelled", "completed"].includes(r.status)) { stamp("terminal before any mid-run gate", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(4000);
}

// ── THE PLACEHOLDER WINDOW, IN THE APP'S OWN DARK PALETTE ─────────────────
const reviewGate = async () => (await db.query(
  `SELECT id, review_task_id, status, created_at FROM cinatra.artifact_review_gates WHERE run_id=$1 ORDER BY created_at`, [RUN])).rows;
const slotOf = async (p) => p.evaluate(() => {
  const s = document.querySelector("[data-run-review-slot]");
  return s
    ? { slot: s.getAttribute("data-run-review-slot"), placeholder: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length, gate: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length, dark: document.documentElement.classList.contains("dark") }
    : { slot: null, placeholder: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length, gate: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length, dark: document.documentElement.classList.contains("dark") };
}).catch(() => ({ slot: null, placeholder: 0, gate: 0, dark: null }));

mkdirSync(dirname(CELL), { recursive: true });
const windowLog = [];
let shot = null;
let firstWorkingAt = null, gateSeenAt = null, gateRow = null, afterSwapReading = null;
const t0 = Date.now();
while (Date.now() - t0 < REVIEW_WAIT_MS) {
  const d = await slotOf(page);
  const gs = await reviewGate();
  const now = new Date().toISOString();
  windowLog.push({ at: now, dark: d, reviewGates: gs.length });
  if (d.slot === "working" && d.placeholder > 0 && d.gate === 0) {
    if (!firstWorkingAt) { firstWorkingAt = now; stamp("THE SLOT IS DRAWING THE PLACEHOLDER, in the app's own dark palette", d); }
    if (!shot) {
      // The reader's own viewport, put back at the top of the page: the run
      // page was last scrolled by pressing the mid-run gate's Continue, and the
      // light sibling was shot from the top of the same page. Nothing is
      // pressed and nothing in the product is touched.
      await page.evaluate(() => { window.scrollTo(0, 0); document.scrollingElement && (document.scrollingElement.scrollTop = 0); });
      await page.waitForTimeout(400);
      const afterScroll = await slotOf(page);
      if (afterScroll.slot === "working" && afterScroll.placeholder > 0 && afterScroll.gate === 0) {
        await page.screenshot({ path: CELL });
        shot = { path: CELL, at: new Date().toISOString(), observed: afterScroll, scrolledToTop: true };
        stamp("the dark placeholder was photographed", shot);
      }
    }
  }
  if (gs.length > 0) { gateSeenAt = now; gateRow = gs[gs.length - 1]; stamp("THE ARTIFACT REVIEW GATE IS ON FILE", { reviewTaskId: gateRow.review_task_id, status: gateRow.status, createdAt: gateRow.created_at }); break; }
  const r = await runRow();
  if (["failed", "cancelled"].includes(r.status)) { stamp("the run reached a terminal status with no review gate", { status: r.status, error: r.error }); break; }
  await page.waitForTimeout(1500);
}
// THE SWAP, on the SAME element, with no press and no navigation of the reader's.
for (let i = 0; i < 40; i += 1) {
  const d = await slotOf(page);
  if (d.slot === "review" && d.gate > 0 && d.placeholder === 0) { afterSwapReading = { at: new Date().toISOString(), ...d }; break; }
  await page.waitForTimeout(1500);
}
stamp("the slot after the mint, on the same element, untouched", afterSwapReading ?? { note: "not observed within the poll" });

const finalRun = await runRow();
const gates = await gatesOf();
const rg = await reviewGate();
const themeFinal = await readTheme();
const tail = (() => { try { return readFileSync(SERVER_LOG, "utf8").slice(startOffset); } catch { return ""; } })();
const out = {
  runId: RUN,
  threadUrl,
  runPage: RUN_PAGE,
  finalRun,
  theme: { before: themeBefore, afterTheAppsOwnControl: themeAfter, atTheEnd: themeFinal },
  hitlGates: gates,
  reviewGates: rg,
  reviewTaskId: rg.length ? rg[rg.length - 1].review_task_id : null,
  midrunAnsweredAt,
  placeholderWindow: {
    firstWorkingReadingAt: firstWorkingAt,
    reviewGateOnFileAt: gateSeenAt,
    reviewGateCreatedAt: gateRow?.created_at ?? null,
    measuredWindowMs: firstWorkingAt && gateSeenAt ? Date.parse(gateSeenAt) - Date.parse(firstWorkingAt) : null,
    shot,
    afterSwapReading,
    samples: windowLog.length,
    log: windowLog,
  },
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
console.log(JSON.stringify({ runId: RUN, runPage: RUN_PAGE, status: finalRun.status, dark: themeFinal.dark, windowMs: out.placeholderWindow.measuredWindowMs, shot: Boolean(shot) }, null, 1));
await db.end();
await browser.close();
