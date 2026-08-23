// ---------------------------------------------------------------------------
// THE REAL WALK (cinatra#2788 S9d, PR #2939 round 2).
//
// Nothing here seeds a transcript, mints a token or writes an assistant turn.
// Every card in every capture comes from ONE path: a sentence typed into the
// shipped /chat composer, answered by the scripted model bridge
// (CINATRA_TEST_LLM_PROVIDER=scripted), which calls the SHIPPED producer
// `schedule_proposal_render` over self-MCP. The proposal ref in the DATA_PART
// is minted by the product, not by this file.
//
// EVERY CAPTURE IS THE FULL BROWSER WINDOW — `page.screenshot()` with no clip,
// no element handle and no fullPage — so the conversation or the page around
// the card is visible. That is the maintainer's first rejection of round 1.
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.WALK_BASE;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const OUT = process.env.OUT_DIR;
const STATE_PATH = process.env.STATE_JSON;
const STEP = process.env.WALK_STEP;
fs.mkdirSync(OUT, { recursive: true });

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : {};
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const log = (...a) => console.log("[walk]", ...a);

const SENTENCE = `Schedule ${IDS.templateId} to run every day at 09:00.`;
const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';

const cookies = IDS.cookie.split("; ").map((c) => {
  const i = c.indexOf("=");
  return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
});

const browser = await chromium.launch();

async function context(theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => {
    try { window.localStorage.setItem("theme", t); } catch { /* record says what resolved */ }
  }, theme === "dark" ? "dark" : "cinatra");
  return ctx;
}

async function openPage(ctx, urlPath) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(BASE + urlPath, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForLoadState("load").catch(() => {});
  return { page, errors };
}

/** THE FULL BROWSER WINDOW. No clip, no element, no fullPage. */
async function shoot(page, cell) {
  await page.waitForTimeout(1200);
  const file = path.join(OUT, `${cell}.png`);
  await page.screenshot({ path: file });
  const box = page.viewportSize();
  log("shot", cell, `${box.width}x${box.height} @2 =`, `${box.width * 2}x${box.height * 2}`);
  return file;
}

/** What the card actually shows, read off the live DOM — the grading input. */
async function observe(page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const seen = (q) => !!(root && root.querySelector(q));
    const text = root ? (root.textContent || "") : "";
    return {
      cardPresent: !!root,
      host: root?.getAttribute("data-lifecycle-card-host") ?? null,
      state: root?.getAttribute("data-lifecycle-card-state") ?? null,
      cardCount: document.querySelectorAll(sel).length,
      themeClass: document.documentElement.className,
      optionRows: seen('[data-conformance-id="schedule-option-rows"]'),
      floor: seen('[data-conformance-id="schedule-proposal-floor"]'),
      confirm: seen('[data-action="confirm-schedule-proposal"]'),
      save: seen('[data-action="save-schedule-changes"]'),
      cancel: seen('[data-action="cancel-trigger-schedule"]'),
      release: seen('[data-action="release-trigger-now"]'),
      // The four the maintainer had removed — each must read false / absent.
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
      saysCancelSchedule: text.includes("Cancel schedule"),
      saysRunNow: text.includes("Run now"),
      cardText: text.replace(/\s+/g, " ").trim().slice(0, 700),
    };
  }, CARD);
}

/** Type the sentence into the shipped composer and send it. */
async function state_a_schedule(page) {
  const composer = 'div[contenteditable="true"][role="textbox"]';
  await page.waitForSelector(composer, { timeout: 180000 });
  await page.click(composer);
  await page.type(composer, SENTENCE, { delay: 8 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  log("sentence sent:", SENTENCE);
}

async function waitForCard(page, wantState, timeoutMs = 420000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const o = await observe(page);
    if (o.cardPresent && (!wantState || o.state === wantState)) return o;
    await page.waitForTimeout(2500);
  }
  throw new Error(`card never reached state=${wantState}`);
}

// ---------------------------------------------------------------------------

if (STEP === "EXPIRED_CLOCK") {
  // Thread E: a schedule stated and then LEFT ALONE. Its 30 minutes run from
  // the moment the producer minted it, which is what makes the expired capture
  // real rather than a stand-in.
  const ctx = await context("light");
  const { page } = await openPage(ctx, "/chat");
  await state_a_schedule(page);
  const o = await waitForCard(page, "pending");
  state.expired = { url: page.url(), startedAt: new Date().toISOString(), observed: o };
  save();
  log("EXPIRED thread:", page.url(), "minted at", state.expired.startedAt);
  await ctx.close();
}

if (STEP === "C1_C2") {
  // Thread A: the one real run. C1 in both themes BEFORE Confirm (there is no
  // going back once it is pressed), then Confirm once, then C2 in both themes.
  const ctxL = await context("light");
  const { page: pL } = await openPage(ctxL, "/chat");
  await state_a_schedule(pL);
  const o1 = await waitForCard(pL, "pending");
  state.run = { threadUrl: pL.url(), statedAt: new Date().toISOString() };
  save();
  log("run thread:", pL.url());
  state.cells = state.cells || {};
  state.cells.C1_light = { shot: await shoot(pL, "C1__chat-before-confirm__light"), observed: o1 };
  save();

  const ctxD = await context("dark");
  const { page: pD } = await openPage(ctxD, new URL(pL.url()).pathname + new URL(pL.url()).search);
  const o1d = await waitForCard(pD, "pending");
  state.cells.C1_dark = { shot: await shoot(pD, "C1__chat-before-confirm__dark"), observed: o1d };
  save();

  // THE PRESS. One press, in the light context, on the shipped control.
  await pL.click('[data-action="confirm-schedule-proposal"]');
  log("Confirm pressed at", new Date().toISOString());
  state.run.confirmedAt = new Date().toISOString();
  const o2 = await waitForCard(pL, "settled");
  state.cells.C2_light = { shot: await shoot(pL, "C2__chat-after-confirm__light"), observed: o2 };
  save();

  await pD.reload({ waitUntil: "domcontentloaded" });
  const o2d = await waitForCard(pD, "settled");
  state.cells.C2_dark = { shot: await shoot(pD, "C2__chat-after-confirm__dark"), observed: o2d };
  save();
  await ctxL.close();
  await ctxD.close();
}

await browser.close();
log("done", STEP);
