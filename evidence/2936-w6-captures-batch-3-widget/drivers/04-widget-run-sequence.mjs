// THE THIRD-PARTY APPLICATION'S WIDGET, DRIVEN AS A VISITOR DRIVES IT.
//
// One browser, one host page on another site, one embedded widget. The widget
// runs its OWN hosted sign-in; a sentence typed into the widget's own composer
// starts the agent through the widget's own named-agent start; every card that
// then appears is decided by pressing that card's OWN controls inside the frame.
// Nothing is seeded: no run, gate, park, record, review task or status is
// written by this file. Every row it reports was written by the app's own
// dispatch and is read back from the database.
//
// THE RECORDS ARE THE SHIPPED RECORDER'S. This file supplies the browser and
// the gestures; the measurement is `observeWalkCell` from
// `scripts/audit/lib/chat-hitl-capture-recorder.mjs`, reading the live page
// through the shipped `playwrightPage` adapter from
// `scripts/audit/lib/chat-hitl-capture-driver.mjs`, validated by the shipped
// audit tier before it is kept. The claims come from the committed walk plan.
// The shipped `--walk` CLI cannot do this itself and the plan says why.
//
// THE PALETTE is the app's own: next-themes is mounted `attribute="class"` with
// the two themes `cinatra` / `dark` (src/app/providers.tsx), so the palette is a
// class the app's own control writes for the app ORIGIN, and the embed frame is
// a document on that origin. The operating system's colour scheme is never
// emulated and is read back on every frame.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "pg";

import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";
import { observeWalkCell } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const REPO = process.env.REPO_ROOT ?? process.cwd();
const R = "evidence/2936-w6-captures-batch-3-widget";
const PHASES = (process.argv[2] ?? "run1").split(",").map((s) => s.trim()).filter(Boolean);
const HOST_PAGE = process.env.HOST_PAGE_URL;
const APP = process.env.APP_ORIGIN;
const DB_URL = process.env.SUPABASE_DB_URL;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const OUT = process.env.OUT_DIR ?? join(REPO, R, "logs");
const AGENT = process.env.WIDGET_AGENT ?? "@cinatra-ai/blog-draft-writer-agent";
for (const [n, v] of Object.entries({ HOST_PAGE_URL: HOST_PAGE, APP_ORIGIN: APP, SUPABASE_DB_URL: DB_URL, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD }))
  if (!v) throw new Error(`the widget sequence needs ${n}`);
mkdirSync(OUT, { recursive: true });

const PLAN = JSON.parse(readFileSync(join(REPO, R, "capture-walk.json"), "utf8"));
const cellsById = new Map();
for (const step of PLAN.steps) for (const c of step.cells ?? []) cellsById.set(c.cell, c);

const RECORDS_PATH = join(REPO, R, "capture-records.json");
const records = existsSync(RECORDS_PATH) ? JSON.parse(readFileSync(RECORDS_PATH, "utf8")) : [];
const controls = [];
const log = [];
const state = { phases: PHASES, startedAt: new Date().toISOString() };
const say = (m) => { const line = `${new Date().toISOString()} ${m}`; log.push(line); console.log(line); };
const flush = () => {
  writeFileSync(RECORDS_PATH, `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(join(OUT, "sequence.txt"), `${log.join("\n")}\n`);
  writeFileSync(join(OUT, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(REPO, R, "page-controls.json"), `${JSON.stringify(controls, null, 2)}\n`);
};

async function q(sql, params = []) {
  const c = new Client({ connectionString: DB_URL });
  try { await c.connect(); return (await c.query(sql, params)).rows; }
  catch (e) { return [{ error: String(e?.message ?? e).slice(0, 300) }]; }
  finally { await c.end().catch(() => {}); }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await ctx.newPage();
page.setDefaultTimeout(300_000);
const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
// THE NEWEST TURN, IN VIEW. The widget's transcript scrolls inside the frame, so
// a card that has just arrived can be below the fold while the page itself is at
// the top. A picture taken then is a picture of the turn BEFORE it.
async function scrollTranscriptToNewest() {
  await embedFrame()?.evaluate(() => {
    const list = document.querySelector("[data-conversation-list]");
    const scroller = (() => {
      let n = list;
      while (n) {
        const st = getComputedStyle(n);
        if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 8) return n;
        n = n.parentElement;
      }
      return document.scrollingElement;
    })();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const cards = document.querySelectorAll("[data-lifecycle-card]");
    cards[cards.length - 1]?.scrollIntoView({ block: "center", behavior: "instant" });
  }).catch(() => {});
}
const strip = async () => { for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {}); };

// --- the development toolbar's OWN hide affordance, disclosed ---------------
// The dev server draws a development indicator over the corner of every frame.
// It renders nothing of the product. This asks the dev server's own endpoint —
// the one that toolbar's own hide control calls — to stop drawing it, so a
// picture of the product is a picture of the product.
async function hideTheDevelopmentIndicator() {
  const res = await page.request.post(`${APP}/__nextjs_disable_dev_indicator`).catch(() => null);
  say(`the development toolbar's own hide affordance answered ${res ? res.status() : "no answer"}`);
}

// --- the palette, through the app's OWN control ------------------------------
let appTab = null;
async function pressAppThemeControl(want) {
  if (!appTab) {
    appTab = await ctx.newPage();
    await appTab.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 600_000 });
    await appTab.waitForTimeout(8000);
  }
  await appTab.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
  const before = await appTab.evaluate(() => ({ cls: document.documentElement.className, stored: (() => { try { return window.localStorage.getItem("theme"); } catch { return null; } })(), osPrefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches }));
  const control = appTab.locator('button:has(.sr-only:text("Toggle theme")), button:has-text("Toggle theme")').first();
  let pressed = false;
  for (let i = 0; i < 3; i += 1) {
    const isDark = await appTab.evaluate(() => /\bdark\b/.test(document.documentElement.className));
    if (want === "dark" ? isDark : !isDark) break;
    if ((await control.count().catch(() => 0)) === 0) break;
    await control.click({ timeout: 60_000 }).catch(() => {});
    pressed = true;
    await appTab.waitForTimeout(1500);
  }
  const after = await appTab.evaluate(() => ({ cls: document.documentElement.className, stored: (() => { try { return window.localStorage.getItem("theme"); } catch { return null; } })(), osPrefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches }));
  let seen = "";
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(500);
    seen = await embedFrame()?.evaluate(() => document.documentElement.className).catch(() => "") ?? "";
    if (want === "dark" ? /\bdark\b/.test(seen) : !/\bdark\b/.test(seen)) break;
  }
  await page.waitForTimeout(1500);
  const facts = { want, pressed, appBefore: before, appAfter: after, frameClass: seen, followed: want === "dark" ? /\bdark\b/.test(seen) : !/\bdark\b/.test(seen) };
  say(`PALETTE ${JSON.stringify(facts)}`);
  return facts;
}

// --- the shutter, and the mean luminance of what it caught -------------------
async function measureLuminance(absPath, box = null, scale = 2) {
  // TWO NUMBERS, AND BOTH ARE STATED. The whole frame's mean, and the mean over
  // the WIDGET'S OWN REGION. A dark widget sits inside a third-party page with
  // its own light styling, so the whole-frame mean is a reading of that page as
  // much as of the widget; the region mean is the reading the claim is about.
  const b64 = readFileSync(absPath).toString("base64");
  const p = await ctx.newPage();
  try {
    return await p.evaluate(async ({ data, box, scale }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const lum = (d) => {
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4);
      };
      const mean = lum(g.getImageData(0, 0, c.width, c.height).data);
      let regionMean = null;
      if (box) {
        const x = Math.max(0, Math.round(box.x * scale));
        const y = Math.max(0, Math.round(box.y * scale));
        const w = Math.min(c.width - x, Math.round(box.width * scale));
        const h = Math.min(c.height - y, Math.round(box.height * scale));
        if (w > 0 && h > 0) regionMean = lum(g.getImageData(x, y, w, h).data);
      }
      return { mean, regionMean, width: c.width, height: c.height };
    }, { data: b64, box, scale });
  } finally { await p.close(); }
}

async function shootCell(cellName, extra = {}) {
  const cell = cellsById.get(cellName);
  if (!cell) throw new Error(`the walk plan declares no cell "${cellName}"`);
  await strip();
  // THE WHOLE THIRD-PARTY PAGE, UNCROPPED. The window is framed from the top of
  // that page so its own chrome is in the picture beside the widget: a capture
  // scrolled to the card alone is a close-up that cannot show whose page this is.
  await page.evaluate(() => window.scrollTo(0, 0));
  await scrollTranscriptToNewest();
  await page.waitForTimeout(1200);
  let record;
  try {
    record = await observeWalkCell({ page: playwrightPage(page), cell, repoRoot: REPO });
  } catch (e) {
    say(`RECORDER REFUSED "${cellName}": ${String(e?.message ?? e).slice(0, 700)}`);
    state.refusals = state.refusals ?? [];
    state.refusals.push({ cell: cellName, message: String(e?.message ?? e).slice(0, 900) });
    flush();
    return null;
  }
  const abs = join(REPO, record.screenshot);
  const box = await page.locator(".cw-frame").first().boundingBox().catch(() => null);
  const lum = await measureLuminance(abs, box);
  record.meanLuminance = Number(lum.mean.toFixed(1));
  record.widgetRegion = box ? { ...box, meanLuminance: Number((lum.regionMean ?? NaN).toFixed(1)) } : null;
  record.pixels = { width: lum.width, height: lum.height };
  record.themeClass = await embedFrame()?.evaluate(() => document.documentElement.className).catch(() => "") ?? "";
  record.osPrefersDark = await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  Object.assign(record, extra);
  const i = records.findIndex((r) => r.cell === record.cell);
  if (i >= 0) records[i] = record; else records.push(record);
  say(`RECORDED ${record.cell} sha256=${record.sha256.slice(0, 16)}… luminance=${record.meanLuminance} theme="${record.themeClass}" osPrefersDark=${record.osPrefersDark}`);
  say(`  assertions ${JSON.stringify(record.assertions)}`);
  flush();
  return record;
}

async function shootControl(name, note, extra = {}) {
  await strip();
  await page.evaluate(() => window.scrollTo(0, 0));
  await scrollTranscriptToNewest();
  await page.waitForTimeout(800);
  const rel = `${R}/cells/${name}.png`;
  const abs = join(REPO, rel);
  mkdirSync(dirname(abs), { recursive: true });
  await page.screenshot({ path: abs });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const box = await page.locator(".cw-frame").first().boundingBox().catch(() => null);
  const lum = await measureLuminance(abs, box);
  const entry = { name, screenshot: rel, sha256, meanLuminance: Number(lum.mean.toFixed(1)), widgetRegion: box ? { ...box, meanLuminance: Number((lum.regionMean ?? NaN).toFixed(1)) } : null, pixels: { width: lum.width, height: lum.height }, at: new Date().toISOString(), note, ...extra };
  controls.push(entry);
  say(`CONTROL ${name} sha256=${sha256.slice(0, 16)}… luminance=${entry.meanLuminance}`);
  flush();
  return entry;
}

// --- the frame's own hosted sign-in ------------------------------------------
async function openHostPageAndSignIn(threadId) {
  const url = new URL(HOST_PAGE);
  url.searchParams.set("thread", threadId);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 600_000 });
  let frame = null;
  for (let i = 0; i < 150 && !frame; i += 1) { await page.waitForTimeout(2000); frame = embedFrame(); }
  if (!frame) throw new Error("the embed frame never loaded inside the third-party page");
  for (let i = 0; i < 150; i += 1) {
    const ready = await embedFrame()?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]")) || Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))).catch(() => false);
    if (ready) break;
    await page.waitForTimeout(2000);
  }
  const signin = embedFrame().locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("the frame is anonymous — running the frame's OWN hosted sign-in");
    const opened = [];
    const onPage = (pg) => opened.push(pg);
    ctx.on("page", onPage);
    await signin.click({ timeout: 180_000 });
    let popup = null;
    for (let i = 0; i < 120 && !popup; i += 1) { await page.waitForTimeout(1000); popup = opened[0] ?? null; }
    ctx.off("page", onPage);
    if (!popup) throw new Error("the sign-in press opened no window");
    await popup.waitForLoadState("domcontentloaded", { timeout: 300_000 }).catch(() => {});
    await popup.waitForTimeout(3000).catch(() => {});
    if (!popup.isClosed()) {
      const ef = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await ef.count().catch(() => 0)) > 0) {
        await ef.fill(EMAIL).catch(() => {});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD).catch(() => {});
        await popup.locator('button[type="submit"]').first().click().catch(() => {});
        await popup.waitForTimeout(7000).catch(() => {});
      }
    }
    for (let i = 0; i < 5 && !popup.isClosed(); i += 1) {
      const b = popup.locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")').first();
      if ((await b.count().catch(() => 0)) === 0) break;
      await b.click({ timeout: 30_000 }).catch(() => {});
      await popup.waitForTimeout(3000).catch(() => {});
    }
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 180_000 }).catch(() => {});
  }
  for (let i = 0; i < 150; i += 1) {
    await page.waitForTimeout(2000);
    const active = await embedFrame()?.evaluate(() => Boolean(document.querySelector('[data-embed-assistant][data-phase="active"]'))).catch(() => false);
    if (active) { say(`the widget reached its ACTIVE phase after ~${(i + 1) * 2}s`); return; }
  }
  throw new Error("the widget never reached its active phase");
}

async function sendTurn(text) {
  const composer = embedFrame().locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 600_000 });
  await composer.click();
  await composer.type(text, { delay: 10 });
  const at = new Date();
  await composer.press("Enter");
  say(`TURN SENT through the widget's OWN composer at ${at.toISOString()}: ${JSON.stringify(text)}`);
  return at;
}

const transcript = async () => embedFrame()?.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ")).catch(() => "") ?? "";

const CARD = {
  hold: '[data-lifecycle-card="recommendation_hold"]',
  review: '[data-lifecycle-card="artifact_review_gate"]',
  schedule: '[data-lifecycle-card="trigger_schedule_proposal"]',
};
const countInFrame = async (sel) => embedFrame()?.evaluate((s) => document.querySelectorAll(s).length, sel).catch(() => 0) ?? 0;
const stateOf = async (sel) => embedFrame()?.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state") ?? null, sel).catch(() => null) ?? null;
async function waitFor(sel, seconds, predicate) {
  for (let i = 0; i < seconds; i += 1) {
    await page.waitForTimeout(1000);
    const n = await countInFrame(sel);
    if (predicate ? await predicate() : n > 0) return { seconds: i + 1, count: n };
  }
  return null;
}
const chipReadout = async () => embedFrame()?.evaluate((rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return [];
  return [...root.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
    skillId: c.getAttribute("data-skill-id"),
    mark: c.getAttribute("data-chip-mark"),
    text: (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
  }));
}, CARD.hold).catch(() => []) ?? [];

// WHAT THE WIDGET'S COLUMN IS DRAWING, read off the live frame.
const inventory = async () => embedFrame()?.evaluate(() => ({
  cards: [...document.querySelectorAll("[data-lifecycle-card]")].map((e) => ({
    kind: e.getAttribute("data-lifecycle-card"),
    host: e.getAttribute("data-lifecycle-card-host"),
    state: e.getAttribute("data-lifecycle-card-state"),
  })),
  conformance: [...new Set([...document.querySelectorAll("[data-conformance-id]")].map((e) => e.getAttribute("data-conformance-id")))],
  actions: [...new Set([...document.querySelectorAll("[data-action]")].map((e) => e.getAttribute("data-action")))],
  slots: document.querySelectorAll("[data-run-review-slot]").length,
  text: (document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 1200),
})).catch(() => null) ?? null;

const HITL_CARD = '[data-lifecycle-card="agent_hitl_screen"]';
// ANSWER WHATEVER SCREEN THE WIDGET DRAWS, with the card's own controls. The
// agent asks more than once — its setup field first, then a mid-run selection —
// so waiting for the review means answering each screen as it arrives.
async function answerTheHitlScreenIfDrawn(label) {
  const f = embedFrame();
  if (!f) return false;
  if ((await countInFrame(HITL_CARD)) === 0) return false;
  await scrollTranscriptToNewest();
  const fields = f.locator(`${HITL_CARD} [data-conformance-id="hitl-screen-fields"] textarea, ${HITL_CARD} [data-conformance-id="hitl-screen-fields"] input[type="text"], ${HITL_CARD} [data-conformance-id="hitl-screen-fields"] input:not([type])`);
  const nf = await fields.count().catch(() => 0);
  for (let i = 0; i < nf; i += 1) {
    const v = await fields.nth(i).inputValue().catch(() => "");
    if (!v) await fields.nth(i).fill(process.env.WIDGET_IDEA ?? "A sustainable weekly publishing rhythm for small teams").catch(() => {});
  }
  const boxes = f.locator(`${HITL_CARD} input[type="checkbox"], ${HITL_CARD} input[type="radio"], ${HITL_CARD} [role="checkbox"], ${HITL_CARD} [role="radio"]`);
  const nb = await boxes.count().catch(() => 0);
  let checked = 0;
  for (let i = 0; i < nb; i += 1) {
    const on = await boxes.nth(i).evaluate((el) => el.getAttribute("aria-checked") === "true" || el.checked === true).catch(() => false);
    if (on) checked += 1;
  }
  if (nb > 0 && checked === 0) {
    await boxes.first().scrollIntoViewIfNeeded().catch(() => {});
    await boxes.first().click({ timeout: 60_000 }).catch(() => {});
    checked = 1;
  }
  await page.waitForTimeout(1000);
  const submit = f.locator(`${HITL_CARD} [data-action="submit-hitl-screen"]`).first();
  const ns = await submit.count().catch(() => 0);
  if (ns > 0) {
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click({ timeout: 120_000 }).catch((e) => say(`the submit could not be pressed: ${String(e).slice(0, 120)}`));
  }
  say(`ANSWERED the HITL screen (${label}): fields=${nf} options=${nb} checkedFirst=${checked} submits=${ns}`);
  await page.waitForTimeout(6000);
  return true;
}

const THREAD = process.env.WIDGET_THREAD_ID ?? "w6b3-northwind-blog";
state.threadId = THREAD;

try {
  await hideTheDevelopmentIndicator();
  await openHostPageAndSignIn(THREAD);
  state.cookieJar = (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly }));
  say(`COOKIE JAR in the browser at capture time: ${JSON.stringify(state.cookieJar)}`);

  // ---------------------------------------------------------------- run 1 ---
  if (PHASES.includes("run1")) {
    const RESUME = process.env.RESUME_RUN_ID ?? "";
    const startedAt = new Date();
    let runRow = null;
    if (RESUME) {
      state.run1 = { resumed: RESUME };
      runRow = (await q(`select id, status, human_present, template_id, source_type, created_at from cinatra.agent_runs where id = $1`, [RESUME]))[0] ?? null;
      say(`RESUMING the run this round already started, without sending a turn: ${RESUME}`);
    } else {
      state.run1 = { promptAt: (await sendTurn(`Please start the agent ${AGENT} for me.`)).toISOString() };
      for (let i = 0; i < 90 && !runRow; i += 1) {
        await page.waitForTimeout(4000);
        const rows = await q(`select id, status, human_present, template_id, source_type, created_at from cinatra.agent_runs where created_at > $1 order by created_at asc limit 1`, [startedAt.toISOString()]);
        if (rows[0]?.id) runRow = rows[0];
      }
    }
    if (!runRow) throw new Error("no agent_runs row appeared for the widget's own turn");
    state.run1.row = runRow;
    say(`RUN 1 ROW ${JSON.stringify(runRow)}`);
    state.run1.park = await q(`select id, checkpoint, status, created_at from cinatra.lifecycle_continuation_park where run_id = $1`, [runRow.id]);
    say(`RUN 1 PARK ${JSON.stringify(state.run1.park)}`);

    // THE SETUP SCREEN COMES FIRST. The agent this round starts asks for its own
    // setup field before anything else, so the widget's first card is the HITL
    // screen and the recommendation hold only opens after it is answered. It is
    // answered here the way a visitor answers it: the fields the card itself
    // draws, and the card's own submit.

    const HITL = '[data-lifecycle-card="agent_hitl_screen"]';
    await waitFor(HITL, 240, async () => (await countInFrame(HITL)) > 0 || (await countInFrame(CARD.hold)) > 0);
    state.run1.firstCard = await inventory();
    say(`FIRST CARD INVENTORY ${JSON.stringify(state.run1.firstCard)}`);
    if ((await countInFrame(HITL)) > 0) {
      say("the widget's first card is the agent's OWN setup screen — answering it on the card's own fields");
      await shootControl("S0__agent-hitl-screen-before-the-hold__site_widget__asking__light", "The agent's own setup screen drawn BEFORE any recommendation hold, as the third-party application's widget column draws it.", { cards: state.run1.firstCard?.cards ?? [] });
      const f0 = embedFrame();
      const fields = f0.locator(`${HITL} [data-conformance-id="hitl-screen-fields"] textarea, ${HITL} [data-conformance-id="hitl-screen-fields"] input[type="text"], ${HITL} [data-conformance-id="hitl-screen-fields"] input:not([type])`);
      const n = await fields.count();
      say(`the setup screen draws ${n} field(s)`);
      for (let i = 0; i < n; i += 1) {
        await fields.nth(i).fill(process.env.WIDGET_IDEA ?? "A sustainable weekly publishing rhythm for small teams").catch(() => {});
      }
      await page.waitForTimeout(1200);
      const submit = f0.locator(`${HITL} [data-action="submit-hitl-screen"]`).first();
      if ((await submit.count().catch(() => 0)) > 0) { await submit.click({ timeout: 120_000 }); say("pressed the setup screen's OWN submit"); }
      else say("the setup screen draws no submit — it submits on change (the setup-loop shape)");
      await page.waitForTimeout(6000);
      state.run1.afterSetup = await q(`select id, status, lifecycle_moment, lifecycle_card_kind from cinatra.agent_runs where id = $1`, [runRow.id]);
      say(`RUN 1 AFTER THE SETUP ANSWER ${JSON.stringify(state.run1.afterSetup)}`);
    }

    const held = process.env.RESUME_RUN_ID ? { seconds: 0, count: 0 } : await waitFor(CARD.hold, 420);
    say(`the recommendation card appeared in the widget column after ~${held?.seconds ?? "never"}s`);
    if (!held) {
      state.run1.noHoldInventory = await inventory();
      state.run1.noHoldRun = await q(`select id, status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref from cinatra.agent_runs where id = $1`, [runRow.id]);
      state.run1.offered = await q(`select * from cinatra.run_recommendation_offered_set where run_id = $1`, [runRow.id]);
      say(`NO HOLD — inventory ${JSON.stringify(state.run1.noHoldInventory)}`);
      say(`NO HOLD — run ${JSON.stringify(state.run1.noHoldRun)} offered ${JSON.stringify(state.run1.offered)}`);
      throw new Error("the recommendation card never mounted in the widget column");
    }
    if (process.env.RESUME_RUN_ID) {
      say("resumed: the hold cells, the settled cells and the setup answer are already on file — skipping straight to what is not");
    } else {
      await page.waitForTimeout(4000);
      state.run1.chipsHeld = await chipReadout();
      say(`CHIPS HELD ${JSON.stringify(state.run1.chipsHeld)}`);
      await shootCell("W1__recommendation-card__site_widget__held__light", { runId: runRow.id, chips: state.run1.chipsHeld });
      state.run1.themeToDark = await pressAppThemeControl("dark");
      await shootCell("W2__recommendation-card__site_widget__held__dark", { runId: runRow.id, themeFacts: state.run1.themeToDark });
      state.run1.themeToLight = await pressAppThemeControl("light");

      // the decision, chip by chip, on the card's OWN controls
      const f = () => embedFrame();
      const press = async (idx, action) => {
        const btn = f().locator(`${CARD.hold} [data-recommendation-chip]`).nth(idx).locator(`[data-skill-action="${action}"]`).first();
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);
        await btn.click({ timeout: 120_000 });
        say(`pressed ${action} on chip ${idx} (${state.run1.chipsHeld[idx]?.skillId})`);
        await page.waitForTimeout(1500);
      };
      await press(0, "confirm");
      await press(1, "adjust");
      const keep = f().locator('[data-skill-action="adjust-keep"]').first();
      if ((await keep.count().catch(() => 0)) > 0) {
        await keep.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);
        await keep.click({ timeout: 120_000 });
        say("adjust panel: pressed the panel's own 'Keep it in this run'");
        await page.waitForTimeout(1500);
      }
      await press(2, "skip");
      await press(3, "confirm");

      const settled = await waitFor(CARD.hold, 180, async () => (await stateOf(CARD.hold)) === "decided");
      state.run1.settledInPlace = Boolean(settled);
      say(`the row settled IN PLACE after ~${settled?.seconds ?? "never"}s (state=${await stateOf(CARD.hold)})`);
      state.run1.chipsSettled = await chipReadout();
      say(`CHIPS SETTLED ${JSON.stringify(state.run1.chipsSettled)}`);
      await shootCell("W3__recommendation-card__site_widget__settled__light", { runId: runRow.id, chips: state.run1.chipsSettled });
      await pressAppThemeControl("dark");
      await shootCell("W4__recommendation-card__site_widget__settled__dark", { runId: runRow.id, chips: state.run1.chipsSettled });
      await pressAppThemeControl("light");

      // ---- THE AGENT'S OWN SETUP SCREEN, WHICH COMES AFTER THE HOLD ----------
      // This agent asks its own setup question once the skills are settled, so the
      // widget's next card is the HITL screen. It is answered here the way a
      // visitor answers it: the fields the card draws, and the card's own submit.
      const HITL2 = '[data-lifecycle-card="agent_hitl_screen"]';
      const asking = await waitFor(HITL2, 300);
      if (asking) {
        state.run1.hitl = { appearedAfterSeconds: asking.seconds, cards: await inventory() };
        say(`the agent's OWN setup screen appeared in the widget column after ~${asking.seconds}s`);
        await shootControl("S1__agent-hitl-screen__site_widget__asking__light", "The agent's own setup screen, as the third-party application's widget column draws it. The capture contract declares this kind composition-only on `site_widget`; it is drawn here from a real widget-started run.", state.run1.hitl);
        // DRIVE THE SHIPPED RECORDER FOR THE CELL THE CONTRACT REFUSES, and record
        // the refusal in its own words rather than working around it.
        // DRIVE THE SHIPPED RECORDER FOR THE CLAIM THE SHIPPED PLAN VALIDATOR
        // REFUSES, so both refusals are on the record in their own words.
        state.refusedCell = JSON.parse(readFileSync(join(REPO, R, "refused-cell-hitl-site-widget.json"), "utf8")).claim;
        cellsById.set(state.refusedCell.cell, state.refusedCell);
        await shootCell(state.refusedCell.cell, { runId: runRow.id });
        const f1 = embedFrame();
        const fields = f1.locator(`${HITL2} [data-conformance-id="hitl-screen-fields"] textarea, ${HITL2} [data-conformance-id="hitl-screen-fields"] input[type="text"], ${HITL2} [data-conformance-id="hitl-screen-fields"] input:not([type])`);
        const nf = await fields.count();
        say(`the setup screen draws ${nf} field(s)`);
        for (let i = 0; i < nf; i += 1) await fields.nth(i).fill(process.env.WIDGET_IDEA ?? "A sustainable weekly publishing rhythm for small teams").catch(() => {});
        await page.waitForTimeout(1200);
        const sub = f1.locator(`${HITL2} [data-action="submit-hitl-screen"]`).first();
        if ((await sub.count().catch(() => 0)) > 0) {
          await sub.scrollIntoViewIfNeeded().catch(() => {});
          await sub.click({ timeout: 120_000 });
          say("pressed the setup screen's OWN submit inside the widget");
        }
        await page.waitForTimeout(6000);
        state.run1.afterSetup = await q(`select id, status, lifecycle_moment, lifecycle_card_kind from cinatra.agent_runs where id = $1`, [runRow.id]);
        say(`RUN 1 AFTER THE SETUP ANSWER ${JSON.stringify(state.run1.afterSetup)}`);
      }


    }

    // A round that already holds the later readings re-shoots only the cells
    // whose FILES were overwritten by a re-drive, and stops there.
    if (process.env.STOP_AFTER_HOLD === "1") {
      say("STOP_AFTER_HOLD: the hold cells are re-shot and the run is left where it stands");
      flush();
    } else {

    // ---- THE SCHEDULE MOMENT, MEASURED ON THIS HOST ------------------------
    // The run reaches the schedule moment next. What the widget draws there is
    // the measurement; nothing is pressed that the column does not draw.
    let atSchedule = null;
    for (let i = 0; i < 90; i += 1) {
      await page.waitForTimeout(2000);
      const row = (await q(`select id, status, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref from cinatra.agent_runs where id = $1`, [runRow.id]))[0];
      if (row?.lifecycle_moment === "schedule") { atSchedule = row; break; }
      if (row?.status === "running" || row?.status === "completed") break;
    }
    if (atSchedule) {
      await page.waitForTimeout(6000);
      state.run1.scheduleMoment = {
        row: atSchedule,
        inventory: await inventory(),
        scheduleCards: await countInFrame(CARD.schedule),
        confirmControls: await embedFrame()?.evaluate(() => document.querySelectorAll('[data-action="confirm-schedule-proposal"]').length).catch(() => 0) ?? 0,
        turnsCarryingTheCard: await q(`select count(*)::int as n from cinatra.assistant_turns where content::text like '%trigger_schedule_proposal%'`),
      };
      say(`SCHEDULE MOMENT ON site_widget ${JSON.stringify(state.run1.scheduleMoment)}`);
      await shootControl("P2__schedule-moment-in-the-widget__site_widget__light", "The run at its schedule moment, as the third-party application's widget column draws it: the run row carries `lifecycle_moment=schedule` and `lifecycle_card_kind=trigger_schedule_proposal`, and the column draws no schedule card at all (cinatra#3044, measured here on `site_widget`).", state.run1.scheduleMoment);
      await pressAppThemeControl("dark");
      await shootControl("P2__schedule-moment-in-the-widget__site_widget__dark", "The same reading in the palette the reader chose on the app's own control.", state.run1.scheduleMoment);
      await pressAppThemeControl("light");

      if (state.run1.scheduleMoment.scheduleCards === 0) {
        // THE RUN CANNOT BE RELEASED FROM INSIDE THE WIDGET, and that is the
        // defect. To reach the review moment at all the run is released on the
        // app's OWN run page, by the same person, on the screen's own control —
        // DISCLOSED, and the only act in this round taken outside the widget.
        say("the widget draws no schedule card, so the run is released on the app's OWN run page — disclosed");
        const runPage = await ctx.newPage();
        try {
          const slug = process.env.WIDGET_AGENT_SLUG ?? "blog-draft-writer-agent";
          const url = `${APP}/agents/cinatra-ai/${slug}/${runRow.id}`;
          await runPage.goto(url, { waitUntil: "domcontentloaded", timeout: 600_000 });
          await runPage.waitForTimeout(12000);
          await runPage.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
          const cont = runPage.getByRole("button", { name: /^(Continue|Run now|Release now)$/ }).first();
          const n = await cont.count().catch(() => 0);
          say(`the run page's schedule step draws ${n} release control(s)`);
          if (n > 0) { await cont.scrollIntoViewIfNeeded().catch(() => {}); await cont.click({ timeout: 120_000 }); say("pressed the run page's OWN schedule control"); }
          await runPage.waitForTimeout(8000);
          state.run1.released = await q(`select id, status, lifecycle_moment from cinatra.agent_runs where id = $1`, [runRow.id]);
          say(`RUN 1 AFTER THE RELEASE ${JSON.stringify(state.run1.released)}`);
        } finally { await runPage.close(); }
      }
    }

    // ---- the run-progress placeholder, polled on the host the widget draws --
    const slotSamples = [];
    let sawWorking = null, sawReview = null;
    for (let i = 0; i < 260; i += 1) {
      const sample = await embedFrame()?.evaluate(() => ({
        slot: document.querySelector("[data-run-review-slot]")?.getAttribute("data-run-review-slot") ?? null,
        slots: document.querySelectorAll("[data-run-review-slot]").length,
        placeholder: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length,
        gate: document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
      })).catch(() => null);
      if (sample) {
        slotSamples.push({ at: new Date().toISOString(), ...sample });
        if (!sawWorking && sample.placeholder > 0 && sample.gate === 0) {
          sawWorking = slotSamples.at(-1);
          await shootControl("P1__run-progress-placeholder__site_widget__light", "The slot the review card will fill, as the widget column draws it while the run works.", sawWorking);
        }
        if (sample.gate > 0) { sawReview = slotSamples.at(-1); break; }
      }
      await page.waitForTimeout(2000);
    }
    state.run1.slotReadings = { sawWorking, sawReview, samples: slotSamples.length, lastSample: slotSamples.at(-1) ?? null };
    say(`SLOT READINGS ${JSON.stringify(state.run1.slotReadings)}`);
    if (!sawWorking) {
      await shootControl("P1__run-progress-placeholder-absent__site_widget__light", "The widget column while the run works: NO element carries `data-run-review-slot` and no review-gate placeholder is drawn on this host.", state.run1.slotReadings);
    }

    // ---- the review, pending ------------------------------------------------
    // The agent asks again mid-run (its context selection), so waiting for the
    // review means answering each screen the widget draws on the way.
    let reviewUp = null;
    for (let i = 0; i < 300 && !reviewUp; i += 1) {
      await page.waitForTimeout(3000);
      if ((await countInFrame(CARD.review)) > 0) { reviewUp = { seconds: i * 3 }; break; }
      if ((await countInFrame(HITL_CARD)) > 0) {
        const row = (await q(`select review_task_id, field_name, x_renderer from cinatra.agent_run_hitl_gates where run_id = $1 order by created_at desc limit 1`, [runRow.id]))[0] ?? null;
        state.run1.midRunGates = state.run1.midRunGates ?? [];
        state.run1.midRunGates.push(row);
        await shootControl(`S2__agent-hitl-screen-mid-run__site_widget__asking__light__${state.run1.midRunGates.length}`, "A mid-run screen the agent asks inside the third-party application's widget column, before its review opens.", { gate: row });
        await answerTheHitlScreenIfDrawn(`mid-run ${state.run1.midRunGates.length}`);
      }
    }
    say(`the review card appeared in the widget column after ~${reviewUp?.seconds ?? "never"}s`);
    state.run1.gates = await q(`select id, run_id, status, disposition, created_at, resolved_at from cinatra.artifact_review_gates where run_id = $1 order by created_at`, [runRow.id]);
    say(`RUN 1 GATES ${JSON.stringify(state.run1.gates)}`);

    // A CARD THAT DID NOT ARRIVE ON THE LIVE PAGE MAY STILL BE PROJECTED ON A
    // FRESH LOAD, and the difference between those two readings is the finding.
    // So the page is reloaded and the widget signs in again, and the same count
    // is taken a second time.
    if (!reviewUp) {
      state.run1.liveReading = { reviewCards: await countInFrame(CARD.review), inventory: await inventory() };
      say(`NO REVIEW CARD ON THE LIVE PAGE ${JSON.stringify(state.run1.liveReading)}`);
      await shootControl("P3__review-absent-on-the-live-widget__site_widget__light", "The widget column with the run's artifact review gate PENDING in the database and no review card drawn on the live page.", state.run1.liveReading);
      say("reloading the third-party page and signing the widget in again, to read the same question a second time");
      await openHostPageAndSignIn(THREAD);
      await page.waitForTimeout(15000);
      for (let i = 0; i < 60 && !reviewUp; i += 1) {
        await page.waitForTimeout(3000);
        if ((await countInFrame(CARD.review)) > 0) { reviewUp = { seconds: i * 3, afterReload: true }; break; }
      }
      state.run1.afterReloadReading = { reviewCards: await countInFrame(CARD.review), inventory: await inventory() };
      say(`AFTER THE RELOAD ${JSON.stringify(state.run1.afterReloadReading)}`);
      if (!reviewUp) await shootControl("P4__review-absent-after-a-reload__site_widget__light", "The same widget conversation after the third-party page was reloaded and the widget signed in again: the gate is still pending and the column still draws no review card.", state.run1.afterReloadReading);
    }
    if (reviewUp) {
      await page.waitForTimeout(6000);
      await shootCell("W5__review-card__site_widget__pending__light", { runId: runRow.id });
      await pressAppThemeControl("dark");
      await shootCell("W6__review-card__site_widget__pending__dark", { runId: runRow.id });
      await pressAppThemeControl("light");
      state.run1.pendingBar = await embedFrame()?.evaluate(() => ({
        bars: document.querySelectorAll('[data-conformance-id="review-decision-bar"]').length,
        approve: document.querySelectorAll('[data-action="approve-review -> resolved"]').length,
        reject: document.querySelectorAll('[data-action="reject-review -> resolved"]').length,
        comment: document.querySelectorAll('[data-action="comment-review -> annotated"]').length,
      })).catch(() => null) ?? null;
      say(`THE FLOOR THE WIDGET DRAWS ${JSON.stringify(state.run1.pendingBar)}`);
    }
    }
    flush();
  }

  // ------------------------------------------------------------- schedule ---
  // THE HELD CARRIER: a schedule the person states in the widget's own
  // conversation BEFORE any run exists. The card writes nothing until Confirm.
  if (PHASES.includes("schedule")) {
    state.schedule = {};
    const sentence = process.env.WIDGET_SCHEDULE_SENTENCE ?? `Run the agent ${AGENT} every weekday at 9 in the morning.`;
    state.schedule.sentence = sentence;
    state.schedule.runsBefore = await q(`select count(*)::int as n from cinatra.agent_runs`);
    state.schedule.sentAt = (await sendTurn(sentence)).toISOString();
    const up = await waitFor(CARD.schedule, 300);
    say(`the schedule card appeared in the widget column after ~${up?.seconds ?? "never"}s`);
    state.schedule.appeared = Boolean(up);
    state.schedule.inventory = await inventory();
    say(`SCHEDULE INVENTORY ${JSON.stringify(state.schedule.inventory)}`);
    if (up) {
      await page.waitForTimeout(4000);
      state.schedule.confirmControls = await countInFrame('[data-action="confirm-schedule-proposal"]');
      state.schedule.saveControls = await countInFrame('[data-action="save-schedule-changes"]');
      state.schedule.runsWhileStated = await q(`select count(*)::int as n from cinatra.agent_runs`);
      state.schedule.triggersWhileStated = await q(`select count(*)::int as n from cinatra.agent_run_triggers`);
      say(`STATED: confirm=${state.schedule.confirmControls} save=${state.schedule.saveControls} runs=${JSON.stringify(state.schedule.runsWhileStated)} triggers=${JSON.stringify(state.schedule.triggersWhileStated)}`);
      await shootCell("W9__schedule-card__site_widget__pending__light", { statedSentence: sentence, confirmControls: state.schedule.confirmControls });
      await pressAppThemeControl("dark");
      await shootCell("W10__schedule-card__site_widget__pending__dark", { statedSentence: sentence });
      await pressAppThemeControl("light");

      const confirm = embedFrame().locator('[data-action="confirm-schedule-proposal"]').first();
      if ((await confirm.count().catch(() => 0)) > 0) {
        await confirm.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);
        await confirm.click({ timeout: 120_000 });
        say("pressed the schedule card's OWN Confirm inside the widget");
      }
      for (let i = 0; i < 90; i += 1) {
        await page.waitForTimeout(2000);
        if ((await stateOf(CARD.schedule)) === "decided" || (await countInFrame('[data-action="save-schedule-changes"]')) > 0) break;
      }
      state.schedule.afterConfirm = {
        cardState: await stateOf(CARD.schedule),
        confirmControls: await countInFrame('[data-action="confirm-schedule-proposal"]'),
        saveControls: await countInFrame('[data-action="save-schedule-changes"]'),
        cards: await countInFrame(CARD.schedule),
        runs: await q(`select count(*)::int as n from cinatra.agent_runs`),
        triggers: await q(`select id, template_id, schedule_kind, next_run_at, created_at from cinatra.agent_run_triggers order by created_at desc limit 3`),
      };
      say(`AFTER CONFIRM ${JSON.stringify(state.schedule.afterConfirm)}`);
      await shootCell("W11__schedule-card__site_widget__decided__light", state.schedule.afterConfirm);
      await pressAppThemeControl("dark");
      await shootCell("W12__schedule-card__site_widget__decided__dark", state.schedule.afterConfirm);
      await pressAppThemeControl("light");
    }
    flush();
  }

  // -------------------------------------------------------------- reload ----
  // Section 6's reload clause on this host: the third-party page is reloaded,
  // the widget signs in again, and the cards are photographed still there.
  if (PHASES.includes("reload")) {
    state.reload = { before: await inventory() };
    await openHostPageAndSignIn(THREAD);
    await page.waitForTimeout(20000);
    await scrollTranscriptToNewest();
    state.reload.after = await inventory();
    state.reload.storedParts = await q(`select count(*)::int as n from cinatra.assistant_turns where thread_id = $1 and content::text like '%recommendation_hold%'`, [THREAD]);
    state.reload.scheduleParts = await q(`select count(*)::int as n from cinatra.assistant_turns where thread_id = $1 and content::text like '%trigger_schedule_proposal%'`, [THREAD]);
    say(`RELOAD before ${JSON.stringify(state.reload.before)}`);
    say(`RELOAD after ${JSON.stringify(state.reload.after)}`);
    say(`RELOAD stored parts ${JSON.stringify(state.reload.storedParts)} schedule parts ${JSON.stringify(state.reload.scheduleParts)}`);
    if ((await countInFrame(CARD.hold)) > 0) {
      await shootCell("W13__recommendation-card__site_widget__settled__after-reload__light", state.reload);
      await pressAppThemeControl("dark");
      await shootCell("W14__recommendation-card__site_widget__settled__after-reload__dark", state.reload);
      await pressAppThemeControl("light");
    }
    if ((await countInFrame(CARD.schedule)) > 0) {
      await shootCell("W15__schedule-card__site_widget__decided__after-reload__light", state.reload);
    }
    flush();
  }

  // ------------------------------------------------------------- refusal ----
  // Sections XI and XII: what the widget's own conversation says when a typed
  // message asks for an act it cannot perform.
  if (PHASES.includes("refusal")) {
    state.refusal = {};
    const before = await transcript();
    const at = await sendTurn(process.env.WIDGET_REFUSAL_SENTENCE ?? "Approve the review for me.");
    state.refusal.sentAt = at.toISOString();
    // WAIT FOR THE ANSWER, not for the message to leave. The turn is the answer,
    // so the shutter waits until the answer is ON SCREEN — a picture taken while
    // it is still in flight is a picture of the question.
    const answered = async () => {
      const t = await transcript();
      return t.length > before.length + 60 && !/Type a message/.test(t.slice(-30));
    };
    for (let i = 0; i < 150; i += 1) {
      await page.waitForTimeout(2000);
      const rows = await q(`select count(*)::int as n from cinatra.assistant_turns where thread_id = $1 and created_at > $2`, [THREAD, at.toISOString()]);
      if ((rows[0]?.n ?? 0) > 0 && (await answered())) { state.refusal.settledAfterSeconds = (i + 1) * 2; break; }
    }
    await page.waitForTimeout(6000);
    state.refusal.transcriptTail = (await transcript()).slice(-900);
    state.refusal.turns = await q(`select left(regexp_replace(content::text,'\s+',' ','g'), 900) as c from cinatra.assistant_turns where thread_id = $1 order by created_at desc limit 2`, [THREAD]);
    state.refusal.cards = await inventory();
    say(`REFUSAL ${JSON.stringify(state.refusal.turns)}`);
    await shootControl("P5__relayed-refusal__site_widget__light", "What the widget's own conversation answers when a typed message asks it to decide a card — sections XI and XII of the drawing.", { sentence: process.env.WIDGET_REFUSAL_SENTENCE ?? "Approve the review for me.", cards: state.refusal.cards });
    flush();
  }
} catch (e) {
  state.error = String(e?.stack ?? e).slice(0, 1500);
  say(`SEQUENCE ERROR: ${state.error}`);
} finally {
  state.finishedAt = new Date().toISOString();
  flush();
  await browser.close();
}
