// ---------------------------------------------------------------------------
// cinatra#2790 S9f — THE REAL SEQUENCE, driven end to end in a real browser.
//
// WHY THIS DRIVER EXISTS. The review page is a surface that exists only AFTER a
// run produced something, and the skills recommendation is decided BEFORE the
// run starts. So a HELD, still-actionable recommendation on the review page is
// a state no real flow can put there. This driver produces the state a real
// flow DOES put there, by walking the order a person walks:
//
//   1. START, person-present — `/agents/<vendor>/<package>/new`, the shipped
//      run-start the Agents card's Run link lands on. It creates the run with
//      `humanPresent: true` and parks it at the recommendation hold
//      (`createAndTriggerRunCore` -> `maybeHoldRunForRecommendation`).
//   2. DECIDE, on the run page, through the CARD'S OWN per-chip controls —
//      one press per chip (`[data-skill-action]`), never a row-level submit,
//      with the Adjust chip settled through its own panel's
//      "Keep it in this run". The row releases itself once every chip carries a
//      decision.
//   3. CONTINUE — the run's own required input, then the trigger form's
//      Continue, so the run leaves the pre-dispatch waiting states the way a
//      person leaves them.
//   4. RECORD what the run's execution actually did, verbatim, whatever it was.
//
// Nothing about the decision is stood in for: the presses are real presses in a
// real browser on the shipped card, and the run's status is read from the
// database on either side by the walk harness, never off the screen.
//
// No origin is hard-coded: the app origin is read from the environment.
//
// Usage: node 05-run-page-real-sequence.mjs <appOrigin> <agentSlug> <outDir>
//        env: S9F_EMAIL, S9F_PW
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2];
const AGENT = process.argv[3];
const OUT = process.argv[4];
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
if (!APP || !AGENT || !OUT || !ACTOR.email || !ACTOR.password) {
  throw new Error("usage: 05-run-page-real-sequence.mjs <appOrigin> <agentSlug> <outDir>; set S9F_EMAIL, S9F_PW");
}
mkdirSync(OUT, { recursive: true });

const CARD = '[data-lifecycle-card="recommendation_hold"]';
const log = [];
const say = (m) => { log.push(m); console.log(m); };

/** ONE press per chip, in this order, so every mark the drawing names appears. */
const DECISION_ORDER = ["confirm", "adjust", "skip", "confirm"];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

/** Every POST the page made, path + status only — never a body, never a value. */
const wire = [];
page.on("response", async (res) => {
  const req = res.request();
  if (req.method() !== "POST") return;
  wire.push({ path: new URL(res.url()).pathname, status: res.status(), at: new Date().toISOString() });
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

/** Sign in through the app's OWN hosted form. Retried, because a fill that
 *  races hydration silently lands on an empty control and the form then refuses
 *  itself — which is a harness fault, not a finding. */
async function signIn() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector('input[name="email"]', { timeout: 300_000 });
    await page.waitForTimeout(4000);
    const em = page.locator('input[name="email"]').first();
    const pw = page.locator('input[name="password"]').first();
    await em.click();
    await em.pressSequentially(ACTOR.email, { delay: 12 });
    await pw.click();
    await pw.pressSequentially(ACTOR.password, { delay: 6 });
    if ((await em.inputValue()) !== ACTOR.email) continue;
    await page.locator('button[type="submit"]').first().click();
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(2000);
      if (!new URL(page.url()).pathname.startsWith("/sign-in")) return new URL(page.url()).pathname;
    }
  }
  throw new Error("sign-in did not leave /sign-in");
}

/** The card root's own read-out: state, per-chip mark, per-chip affordances. */
async function cardReadout() {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return { present: false };
    const attrs = {};
    for (const a of root.attributes) if (a.name !== "class") attrs[a.name] = a.value;
    return {
      present: true,
      attributes: attrs,
      state: root.getAttribute("data-lifecycle-card-state"),
      chips: [...root.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
        skillId: c.getAttribute("data-skill-id"),
        mark: c.getAttribute("data-chip-mark"),
        forced: c.hasAttribute("data-forced"),
        label: (c.querySelector("span")?.textContent ?? "").trim(),
        actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
      })),
      affordances: {
        confirm: root.querySelectorAll('[data-skill-action="confirm"]').length,
        adjust: root.querySelectorAll('[data-skill-action="adjust"]').length,
        skip: root.querySelectorAll('[data-skill-action="skip"]').length,
      },
    };
  }, CARD);
}

const state = {};
try {
  say(`# cinatra#2790 S9f real sequence — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);

  // ---- 1. the person-present start ---------------------------------------
  await page.goto(`${APP}/agents/${AGENT}/new`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForTimeout(10_000);
  const runPath = new URL(page.url()).pathname;
  const runId = runPath.split("/").filter(Boolean).pop();
  state.runId = runId;
  state.runPath = runPath;
  say(`START run page: ${runPath}`);

  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate((s) => Boolean(document.querySelector(s)), CARD)) break;
    await page.waitForTimeout(2000);
  }
  const held = await cardReadout();
  state.held = held;
  say(`HELD ${JSON.stringify(held)}`);
  if (!held.present || held.state !== "held") throw new Error("the run did not park at the recommendation hold");

  // ---- 2. the decision, chip by chip, through the card's own controls -----
  const chipIds = held.chips.map((c) => c.skillId);
  state.decisionPresses = [];
  for (let i = 0; i < chipIds.length; i += 1) {
    const skillId = chipIds[i];
    const action = DECISION_ORDER[i % DECISION_ORDER.length];
    await page.locator(`${CARD} [data-recommendation-chip][data-skill-id="${skillId}"] [data-skill-action="${action}"]`).first().click({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    if (action === "adjust") {
      // The Adjust panel is the chip's own; "Keep it in this run" settles the
      // chip as `adjusted`, the drawing's third mark.
      await page.locator('[data-skill-action="adjust-keep"]').first().click({ timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
    const after = await page.evaluate((s) => {
      const r = document.querySelector(s);
      return r ? r.getAttribute("data-lifecycle-card-state") : "(absent)";
    }, CARD);
    state.decisionPresses.push({ skillId, action, cardStateAfter: after });
    say(`PRESS ${action} on ${skillId} -> card state ${after}`);
  }
  await page.waitForTimeout(12_000);
  state.afterDecision = await cardReadout();
  say(`AFTER-DECISION ${JSON.stringify(state.afterDecision)}`);

  // ---- 3. the run's own input, then the trigger form ----------------------
  const idea = JSON.stringify({
    title: "Connector rollout note",
    summary: "The connector ships this week and replaces the manual export step.",
    outline: ["Summary", "Rollout"],
  });
  // The run's own required input appears only after the release dispatched the
  // run and its executor reached the setup interrupt, which takes tens of
  // seconds on a dev runtime — so this WAITS for the control rather than
  // sampling once and calling its absence an answer.
  for (let i = 0; i < 45; i += 1) {
    if (await page.locator("textarea").count()) break;
    await page.waitForTimeout(4000);
  }
  const ta = page.locator("textarea").first();
  if (await ta.count()) {
    await ta.click();
    await ta.fill(idea);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 120_000 });
    say("CONTINUE pressed on the run's own input");
    await page.waitForTimeout(20_000);
  } else {
    say("CONTINUE skipped — the run asked for no input");
  }

  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(4000);
    if (new URL(page.url()).pathname.endsWith("/trigger")) break;
  }
  if (new URL(page.url()).pathname.endsWith("/trigger")) {
    await page.waitForTimeout(8000);
    await page.getByText(/Run right after setup/i).first().click({ timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 120_000 });
    say("CONTINUE pressed on the trigger form (Run right after setup)");
  } else {
    say(`no trigger form — page is ${new URL(page.url()).pathname}`);
  }

  // ---- 4. what the run's execution actually did ---------------------------
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n"));
    if (/Error|Failed|Complete|Review/i.test(text)) break;
  }
  state.runPageText = (await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n"))).slice(0, 4000);
  await page.screenshot({ path: join(OUT, "run-page-after-execution.png"), fullPage: true });
  say(`WIRE ${JSON.stringify(wire.slice(-40))}`);
  state.wire = wire;
  state.pageErrors = pageErrors;
  say("REAL SEQUENCE OK");
} catch (e) {
  say(`REAL SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(OUT, "real-sequence.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(OUT, "real-sequence.log"), log.join("\n") + "\n");
  await browser.close();
}
