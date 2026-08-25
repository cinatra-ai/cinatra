// ---------------------------------------------------------------------------
// THE WALK — every reading cinatra#2972 owes, on two real runs and a real clock,
// in one pass so the order the plan describes is the order the pictures were
// taken in.
//
//   the ONE-OFF          stated in the composer for an instant minutes ahead,
//                        confirmed on the card, left to come due
//     F1  the card in the conversation after it fired
//     F2  the run page's Schedule step after it fired
//
//   the RECURRING        stated as a daily schedule at HH:MM. Daily is the
//     schedule           smallest recurrence the product can express
//                        (`trigger-recurrence.ts`), and the card's minute is on
//                        a five-minute grid — so it is armed for a boundary
//                        minutes ahead TODAY and fires there.
//     G1  the card in the conversation after its first fire — editable, Save changes
//     G2  the run page after its first fire — Save changes AND Cancel schedule,
//         the Schedule row reachable, the prompt window under the scheduler
//     K1  a row changed (the MINUTE, inside the same hour) and saved — before the next tick
//     K2  after the NEXT REAL TICK, which fires at the saved time
//     J1  after Cancel schedule, on the run page — non-editable, no floor
//     J2  the same stop, read in the conversation
//
//   a THIRD one-off      armed for tomorrow, so it cannot fire during the shoot
//     S9d-C3  configured and not run, on the run page — the one canonical index
//             cell this slice makes stale, re-shot
//
// NOTHING IS WRITTEN. Every state is produced by the product's own surfaces —
// the composer, Confirm, Save changes, Cancel schedule — and every fire is the
// shipped release job on the wall clock. The only SQL is `select`.
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP, SEL, assertRealChain, db, CHILD_CANDIDATES_SQL, RUN_SQL, TRIGGER_SQL,
  USAGE_WINDOW_SQL, readClonesFromServerLog, say, signIn,
} from "./00-lane.mjs";

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const SHOT_DIR_REL = "evidence/2972-schedule-controls/captures";
const TEMPLATE_ID = process.env.LANE_TEMPLATE_ID;
const PKG_PATH = process.env.LANE_PACKAGE_PATH;
const RUN_AT = process.env.RUN_AT;            // the one-off, naive UTC "YYYY-MM-DDTHH:MM"
const REC_HOUR = process.env.REC_HOUR;
const REC_MINUTE = process.env.REC_MINUTE;    // the recurring schedule's first tick
const NEW_MINUTE = process.env.NEW_MINUTE;    // the minute Save changes moves it to
const STOP_MINUTE = process.env.STOP_MINUTE;  // the boundary the STOPPED schedule must not fire on
const FUTURE_RUN_AT = process.env.FUTURE_RUN_AT; // the configured-not-run cell
for (const [k, v] of Object.entries({ TEMPLATE_ID, PKG_PATH, RUN_AT, REC_HOUR, REC_MINUTE, NEW_MINUTE, STOP_MINUTE, FUTURE_RUN_AT }))
  if (!v) throw new Error(`this lane needs ${k}`);
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const { q, end } = await db();
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, timezoneId: "UTC" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
const settle = (ms) => page.waitForTimeout(ms);
const records = [], indexRecords = [], controls = [], timeline = [];
/**
 * A timeline row.
 *
 * `observedAt` is THIS PROCESS'S clock — the moment the read was made — and is
 * named as such.
 *
 * `db` IS A MIXED EVIDENCE BLOCK, not a row of columns. It holds, per step:
 * database rows read at that instant (`trigger`, `run`, `childCandidates` — every
 * field of those is a column); values PARSED OUT OF THE APP SERVER'S LOG
 * (`clonesNamedByTheReleaseJob`); values DERIVED by this driver (`dueAt`,
 * `dueInstantStillAhead`, the `cronBefore` / `lastFiredBeforeStop` snapshots
 * carried over from an earlier read, and the counts); and the provider-evidence
 * block. Each is named for what it is, and nothing here should be read as "a
 * column" unless it came out of one of the row objects.
 */
const stamp = async (step, what, rows) => {
  const r = { step, what, observedAt: new Date().toISOString(), db: rows };
  timeline.push(r);
  say("TIMELINE", step, what, JSON.stringify(rows));
  return r;
};
/** The ledger rows this round produced, read fresh at each shutter. */
const roundStartedAt = new Date();
const usageThisRound = async () => q(USAGE_WINDOW_SQL, [roundStartedAt]);

// ---------------------------------------------------------------------------
// COUNTING. A "root"-scoped anchor is counted on the card's own root ELEMENT
// AND its descendants — the marker the contract asks a decided capture for
// (`data-lifecycle-card-state`) is an attribute of the root itself, and a plain
// `root.querySelectorAll` misses it. That under-count is a false statement about
// the reading, so the count is done with `matches` + `querySelectorAll`.
// ---------------------------------------------------------------------------
const FRAME_ANCHORS = [
  "[data-conversation-list]",
  '[data-lifecycle-card="trigger_schedule_proposal"]',
  '[data-conformance-id="schedule-proposal-card"]',
  '[data-conformance-id="run-step-rail-column"]',
  '[data-conformance-id="run-detail-column"]',
  '[data-conformance-id="schedule-rail-step"]',
  '[data-conformance-id="schedule-step-detail"]',
  '[data-conformance-id="schedule-prompt-window"]',
  '[data-action="release-trigger-now"]',
];
const ROOT_ANCHORS = [
  "[data-lifecycle-card-state]",
  '[data-action="confirm-schedule-proposal"]',
  '[data-conformance-id="schedule-proposal-floor"]',
  '[data-conformance-id="schedule-option-rows"]',
  '[data-action="save-schedule-changes"]',
  '[data-action="cancel-trigger-schedule"]',
  '[data-action="release-trigger-now"]',
  '[data-field="schedule-run-at"]',
  '[data-field="schedule-run-at"][disabled]',
  '[data-field="schedule-timezone"][disabled]',
  '[data-field="recurring-interval"]',
  '[data-field="recurring-interval"]:not([disabled])',
  '[data-field="recurring-interval"][disabled]',
  '[data-field="recurring-frequency"]',
  '[data-field="recurring-frequency"]:not([disabled])',
  '[data-field="recurring-frequency"][disabled]',
  '[data-field="recurring-hour"]',
  '[data-field="recurring-hour"]:not([disabled])',
  '[data-field="recurring-hour"][disabled]',
  '[data-field="recurring-minute"]',
  '[data-field="recurring-minute"]:not([disabled])',
  '[data-field="recurring-minute"][disabled]',
  '[data-field="recurring-timezone"]',
  '[data-field="recurring-timezone"]:not([disabled])',
  '[data-field="recurring-timezone"][disabled]',
  '[data-field="schedule-timezone"]',
  '[data-field="schedule-timezone"]:not([disabled])',
];
async function observe(host) {
  return page.evaluate(({ f, r, h, cardSel }) => {
    const inFrame = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
    const root = document.querySelector(cardSel);
    const inRoot = (s) => {
      if (!root) return 0;
      try { return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length; } catch { return 0; }
    };
    const out = [];
    for (const s of f) out.push({ selector: s, scope: "frame", count: inFrame(s) });
    out.push({ selector: `[data-lifecycle-card-host="${h}"]`, scope: "frame", count: inFrame(`[data-lifecycle-card-host="${h}"]`) });
    out.push({ selector: `[data-lifecycle-card-host="${h}"]`, scope: "root", count: inRoot(`[data-lifecycle-card-host="${h}"]`) });
    for (const s of r) out.push({ selector: s, scope: "root", count: inRoot(s) });
    return out;
  }, { f: FRAME_ANCHORS, r: ROOT_ANCHORS, h: host, cardSel: '[data-lifecycle-card="trigger_schedule_proposal"]' });
}
async function pageReadings() {
  return page.evaluate(() => {
    const detail = document.querySelector('[data-conformance-id="run-detail-column"]');
    const rail = document.querySelector('[data-conformance-id="run-step-rail-column"]');
    const card = document.querySelector('[data-conformance-id="schedule-proposal-card"]');
    const win = document.querySelector('[data-conformance-id="schedule-prompt-window"]');
    const rs = document.querySelector('[data-conformance-id="schedule-rail-step"]');
    return {
      runNowControlsOnThisSurface: document.querySelectorAll('[data-action="release-trigger-now"]').length,
      promptWindowInDetailColumn: !!(detail && win && detail.contains(win)),
      promptWindowOrder: card && win ? (card.compareDocumentPosition(win) & Node.DOCUMENT_POSITION_FOLLOWING ? "prompt-window-after-the-card" : "prompt-window-before-the-card") : null,
      // GEOMETRY, not document order. "Below the scheduler" is a claim about
      // where the window is PAINTED, and document order alone does not carry it.
      promptWindowGeometry: (() => {
        if (!card || !win) return null;
        const c = card.getBoundingClientRect(), w = win.getBoundingClientRect();
        return {
          cardBottom: Math.round(c.bottom), promptTop: Math.round(w.top),
          promptIsBelowTheCard: w.top >= c.bottom - 1,
          promptOverlapsTheCardHorizontally: w.left < c.right && w.right > c.left,
        };
      })(),
      cardInDetailColumn: !!(detail && card && detail.contains(card)),
      railStepPresent: !!rs,
      railStepReachable: rs ? !rs.disabled && rs.getAttribute("aria-disabled") !== "true" : null,
      railStepSelected: rs ? rs.getAttribute("data-schedule-step-selected") : null,
      railLeftOfDetail: !!(rail && detail && rail.getBoundingClientRect().right <= detail.getBoundingClientRect().left + 1),
      detailRightOfRail: (() => {
        if (!rail || !detail) return null;
        const r = rail.getBoundingClientRect(), d = detail.getBoundingClientRect();
        return { railRight: Math.round(r.right), detailLeft: Math.round(d.left), detailStartsRightOfTheRail: d.left >= r.right - 1 };
      })(),
      agenticRunProgressOnThisSurface: [...document.querySelectorAll("h1,h2,h3,h4")].filter((h) => h.textContent.trim() === "Agentic Run Progress").length,
      scheduleLine: (card?.innerText ?? "").replace(/\s+/g, " ").slice(0, 260),
    };
  });
}
async function rootAttributes() {
  return page.evaluate(() => {
    const el = document.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
    return el ? Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])) : {};
  });
}
async function setTheme(which) {
  const label = which === "dark" ? "Dark" : "Light";
  for (let a = 0; a < 4; a += 1) {
    const t = page.getByRole("button", { name: /toggle theme/i }).first();
    if (await t.count()) {
      await t.click(); await settle(700);
      const i = page.getByRole("menuitem", { name: new RegExp(`^${label}$`, "i") }).first();
      if (await i.count()) { await i.click(); await settle(1400); } else await page.keyboard.press("Escape");
    }
    const cls = await page.evaluate(() => document.documentElement.className);
    if (/\bdark\b/.test(cls) === (which === "dark")) return cls;
    await settle(800);
  }
  throw new Error(`the app's own theme control did not settle on ${which}`);
}
async function fitTheWindow(sel) {
  for (let i = 0; i < 8; i += 1) {
    const box = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, inner: window.innerHeight };
    }, sel).catch(() => null);
    if (!box) return;
    if (box.top >= 0 && box.bottom <= box.inner) return;
    const g = Math.min(2800, (page.viewportSize()?.height ?? 1100) + 300);
    if (g === page.viewportSize()?.height) return;
    await page.setViewportSize({ width: 1440, height: g }); await settle(1200);
  }
}
/** THE SHUTTER — always the FULL BROWSER WINDOW. No fullPage, no clip. */
async function shoot(cell, { host, note, runId, dbAt, theme, alsoIndexRecord = false }) {
  const providerEvidence = assertRealChain(cell);
  await page.evaluate(() => { for (const s of ["nextjs-portal", "[data-nextjs-toast]"]) for (const el of document.querySelectorAll(s)) el.remove(); }).catch(() => {});
  const rel = `${SHOT_DIR_REL}/${cell}.png`, abs = join(REPO_ROOT, rel);
  await page.screenshot({ path: abs, scale: "device" });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const assertions = await observe(host);
  const surface = await pageReadings();
  const attrs = await rootAttributes();
  const usageSinceRoundStart = await usageThisRound();
  const finalUrl = new URL(page.url()).pathname;
  const at = new Date().toISOString();
  records.push({
    cell, declaredHost: host, declaredKind: "trigger_schedule_proposal", declaredState: "decided",
    finalUrl, screenshot: rel, sha256, pixels, assertions,
    recordedBy: "cinatra-lifecycle-capture-recorder@1", recordedAt: at, runtime: "dev-runtime",
    providerEvidence, usageSinceRoundStart, note, runId, dbAt, surface, rootAttributes: attrs, theme,
    themeClass: await page.evaluate(() => document.documentElement.className),
    framing: "window", viewport: { ...page.viewportSize(), deviceScaleFactor: 2 },
    pageErrors: [...pageErrors],
  });
  if (alsoIndexRecord) {
    const get = (sel, scope) => assertions.find((a) => a.selector === sel && a.scope === scope)?.count ?? 0;
    indexRecords.push({
      cell, declaredHost: host, finalUrl, build: "development", screenshot: rel, sha256, capturedAt: at,
      assertions: [
        { selector: `[data-lifecycle-card-host="${host}"]`, scope: "frame", count: get(`[data-lifecycle-card-host="${host}"]`, "frame"), frame: "main", expect: "present", visible: get(`[data-lifecycle-card-host="${host}"]`, "frame") },
        { selector: '[data-lifecycle-card="trigger_schedule_proposal"]', scope: "frame", count: get('[data-lifecycle-card="trigger_schedule_proposal"]', "frame"), frame: "main", expect: "present", visible: get('[data-lifecycle-card="trigger_schedule_proposal"]', "frame") },
        { selector: "[data-lifecycle-card-state]", scope: "root", count: get("[data-lifecycle-card-state]", "root"), frame: "main", expect: "present", visible: get("[data-lifecycle-card-state]", "root"), within: '[data-lifecycle-card="trigger_schedule_proposal"]' },
        { selector: `[data-lifecycle-card-host="${host}"]`, scope: "root", count: get(`[data-lifecycle-card-host="${host}"]`, "root"), frame: "main", expect: "present", visible: get(`[data-lifecycle-card-host="${host}"]`, "root"), within: '[data-lifecycle-card="trigger_schedule_proposal"]' },
        { selector: '[data-action="confirm-schedule-proposal"]', scope: "root", count: get('[data-action="confirm-schedule-proposal"]', "root"), frame: "main", expect: "absent", visible: get('[data-action="confirm-schedule-proposal"]', "root"), within: '[data-lifecycle-card="trigger_schedule_proposal"]' },
      ],
      recordedBy: "cinatra-lifecycle-capture-recorder@1",
      declaredKind: "trigger_schedule_proposal", declaredState: "decided", framing: "window",
      instance: { selector: '[data-lifecycle-card="trigger_schedule_proposal"]', matched: get('[data-lifecycle-card="trigger_schedule_proposal"]', "frame"), index: 0, id: null, attributes: attrs },
    });
  }
  controls.push({
    cell, theme, screenshot: rel, sha256, pixels: `${pixels.width}x${pixels.height}`, finalUrlPath: finalUrl,
    runNowControlsOnThisSurface: surface.runNowControlsOnThisSurface,
    promptWindowInDetailColumn: surface.promptWindowInDetailColumn,
    promptWindowOrder: surface.promptWindowOrder,
    railStepReachable: surface.railStepReachable,
    agenticRunProgressOnThisSurface: surface.agenticRunProgressOnThisSurface,
    capturedAt: at,
  });
  say(`CAP ${cell} ${pixels.width}x${pixels.height} runNow=${surface.runNowControlsOnThisSurface} state=${assertions.find((a) => a.selector === "[data-lifecycle-card-state]" && a.scope === "root")?.count}`);
  flush();
}

/** Write what the round has so far, so a late failure keeps what was shot. */
function flush() {
  writeFileSync(process.env.OUT_RECORDS, `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(process.env.OUT_INDEX_RECORDS, `${JSON.stringify(indexRecords, null, 2)}\n`);
  writeFileSync(process.env.OUT_CONTROLS, `${JSON.stringify(controls, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------------------
async function openThread(threadPath) {
  await page.goto(`${APP}${threadPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(SEL.cardRoot, { timeout: 600_000 });
  await settle(7000);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await fitTheWindow(SEL.cardRoot); await settle(800);
}
async function openRunSchedule(runId) {
  await page.goto(`${APP}/agents/${PKG_PATH}/${runId}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(SEL.railStep, { timeout: 600_000 });
  await settle(4000);
  await page.locator(SEL.railStep).first().click();
  await page.waitForSelector(SEL.stepDetail, { timeout: 300_000 });
  await settle(6000);
  await page.setViewportSize({ width: 1440, height: 1100 }); await settle(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await fitTheWindow(SEL.detailColumn); await settle(700);
}
async function choose(fieldSel, label) {
  await page.locator(fieldSel).first().click(); await settle(600);
  await page.getByRole("option", { name: label, exact: true }).first().click(); await settle(800);
}
/**
 * State one sentence in the shipped composer and wait for the model's card.
 *
 * IT RETRIES, and the retries are counted rather than hidden. The runtime makes
 * a reachability probe of the public MCP ingress before every turn and REFUSES
 * the turn when the probe misses its budget (`checkPublicMcpReachability`). A
 * refused turn produces no card and no run — nothing is half-done — so the
 * honest response is to state the sentence again in a fresh conversation. The
 * count lands in `turnsRefusedOrUnanswered` on the walk's own output.
 */
let turnsRefusedOrUnanswered = 0;
async function stateTheSchedule(sentence, { attempts = 6, perAttemptMs = 180_000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector(SEL.composer, { timeout: 300_000 });
    await settle(4000);
    const c = page.locator(SEL.composer).first();
    await c.click();
    await c.pressSequentially(sentence, { delay: 4 });
    await page.keyboard.press("Enter");
    try {
      await page.waitForSelector(`${SEL.card}[data-lifecycle-card-state="pending"]`, { timeout: perAttemptMs });
    } catch {
      turnsRefusedOrUnanswered += 1;
      say(`RETRY attempt ${attempt} produced no card within ${perAttemptMs}ms — stating it again in a fresh conversation`);
      continue;
    }
    await settle(3000);
    return new URL(page.url()).pathname;
  }
  throw new Error("the model never answered the sentence with a card");
}
async function confirmAndReadRun() {
  const known = new Set((await q(`select id from cinatra.agent_runs where template_id=$1`, [TEMPLATE_ID])).map((r) => r.id));
  await page.locator(SEL.floor).first().scrollIntoViewIfNeeded();
  await page.locator(SEL.confirm).first().click();
  await page.waitForSelector(`${SEL.card}[data-lifecycle-card-state="settled"]`, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    const rows = await q(`select id from cinatra.agent_runs where template_id=$1 order by created_at desc`, [TEMPLATE_ID]);
    const fresh = rows.find((r) => !known.has(r.id));
    if (fresh) return fresh.id;
    await settle(2000);
  }
  throw new Error("Confirm settled the card but no new run appeared in the database");
}
async function shootBothThemes(cell, opts) {
  for (const theme of ["light", "dark"]) {
    await opts.open();
    await setTheme(theme); await settle(1400);
    await fitTheWindow(opts.fit);
    await shoot(theme === "dark" ? `${cell}__dark` : cell, { ...opts, theme });
  }
}

// ===========================================================================
say("SIGNIN ->", await signIn(page));
const armedAt = new Date().toISOString();
assertRealChain("before the first turn");

// ---- arm the one-off ------------------------------------------------------
const threadA = await stateTheSchedule(`Please schedule ${TEMPLATE_ID} to run once at ${RUN_AT} in the UTC timezone.`);
await page.locator('[data-schedule-option="scheduled"] button').first().click(); await settle(800);
await page.locator(SEL.timezone).first().fill("UTC");
await page.locator(SEL.runAt).first().fill(RUN_AT);
await settle(800);
const A = await confirmAndReadRun();
say("one-off run", A, "in", threadA);

// ---- arm the recurring schedule -------------------------------------------
const threadB = await stateTheSchedule(`Please schedule ${TEMPLATE_ID} to run every day at ${REC_HOUR}:${REC_MINUTE} in the UTC timezone.`);
await page.locator('[data-schedule-option="recurring"] button').first().click(); await settle(800);
await choose(SEL.recurringInterval, "1");
await choose(SEL.recurringFreq, "day(s)");
await choose(SEL.recurringHour, REC_HOUR);
await choose(SEL.recurringMinute, REC_MINUTE);
await page.locator(SEL.recurringTz).first().fill("UTC");
await settle(800);
const B = await confirmAndReadRun();
say("recurring run", B, "in", threadB);
await stamp("T0", "both schedules armed by Confirm on the card", {
  oneOff: (await q(TRIGGER_SQL, [A]))[0], recurring: (await q(TRIGGER_SQL, [B]))[0],
});

// ---- (1) the one-off, after it fired --------------------------------------
let aTrigger = null;
for (let i = 0; i < 240 && !aTrigger; i += 1) {
  const [t] = await q(TRIGGER_SQL, [A]);
  if (t?.released_at) aTrigger = t; else await settle(5000);
}
if (!aTrigger) throw new Error("the one-off never had `released_at` stamped");
const t1 = await stamp("T1", "the one-off came due on its own and the release job stamped released_at", {
  trigger: aTrigger, run: (await q(RUN_SQL, [A]))[0],
});
await shootBothThemes("F1__schedule-card__chat_thread__settled__one-off-fired", {
  host: "chat_thread", runId: A, dbAt: t1, open: () => openThread(threadA), fit: SEL.cardRoot,
  note: "The card the person confirmed, in the conversation it was stated in, after the one-off came due. Plan (A) §7.2 step 4: once a one-off has fired it cannot be changed.",
});
await shootBothThemes("F2__schedule-card__run_card__settled__one-off-fired", {
  host: "run_card", runId: A, dbAt: t1, open: () => openRunSchedule(A), fit: SEL.detailColumn,
  note: "The run page's Schedule step after the one-off fired: the same form, read-only, and no operation at all.",
});

// ---- (2) the recurring schedule, after one real tick ----------------------
let bFired = null, kids = [];
for (let i = 0; i < 240 && !bFired; i += 1) {
  const [t] = await q(TRIGGER_SQL, [B]);
  kids = await q(CHILD_CANDIDATES_SQL, [TEMPLATE_ID, armedAt, B]);
  if (t?.last_fired_at && kids.length >= 1) bFired = t; else await settle(5000);
}
if (!bFired) throw new Error("the recurring schedule never fired with a child run");
const t2 = await stamp("T2", "the recurring schedule fired one real tick and the release job cloned a child run", {
  trigger: bFired, run: (await q(RUN_SQL, [B]))[0],
  clonesNamedByTheReleaseJob: readClonesFromServerLog(B).clones,
  childCandidates: kids,
});
await shootBothThemes("G1__schedule-card__chat_thread__settled__recurring-fired", {
  host: "chat_thread", runId: B, dbAt: t2, open: () => openThread(threadB), fit: SEL.cardRoot,
  note: "The recurring card in the conversation after its first fire: the same rows, still editable, with Save changes. Cancel schedule is not here — §7.2 puts it on the run page.",
});
await shootBothThemes("G2__schedule-card__run_card__settled__recurring-fired", {
  host: "run_card", runId: B, dbAt: t2, open: () => openRunSchedule(B), fit: SEL.detailColumn,
  note: "The run page after a recurring fire: the Schedule row reachable, the form editable with Save changes and Cancel schedule, and the prompt window under the scheduler.",
});

// ---- (3) a saved change, and the tick that honours it ---------------------
await openRunSchedule(B);
const cronBefore = bFired.cron_expression;
await choose(SEL.recurringMinute, NEW_MINUTE);
await settle(900);
await page.locator(SEL.save).first().click();
let saved = null;
for (let i = 0; i < 60 && !saved; i += 1) {
  await settle(2000);
  const [row] = await q(TRIGGER_SQL, [B]);
  if (row.cron_expression !== cronBefore) saved = row;
}
if (!saved) throw new Error("Save changes did not re-arm the schedule");
const t3 = await stamp("T3", `Save changes moved the fired schedule from ${cronBefore} to ${saved.cron_expression}`, {
  cronBefore, trigger: saved, run: (await q(RUN_SQL, [B]))[0],
});
await shootBothThemes("K1__schedule-card__run_card__settled__saved-change", {
  host: "run_card", runId: B, dbAt: t3, open: () => openRunSchedule(B), fit: SEL.detailColumn,
  note: `A row changed on a schedule that had already fired and saved with the card's own Save changes: the trigger row re-armed from ${cronBefore} to ${saved.cron_expression}. Shot BEFORE the next tick.`,
});

let applied = null, kids2 = [];
for (let i = 0; i < 300 && !applied; i += 1) {
  const [row] = await q(TRIGGER_SQL, [B]);
  kids2 = await q(CHILD_CANDIDATES_SQL, [TEMPLATE_ID, armedAt, B]);
  if (row.last_fired_at && new Date(row.last_fired_at) > new Date(bFired.last_fired_at) && kids2.length > kids.length) applied = row;
  else await settle(5000);
}
if (!applied) throw new Error("the saved change never produced a next tick");
const t4 = await stamp("T4", "the NEXT real tick fired at the SAVED time and the app cloned a second child run", {
  trigger: applied, firstFire: bFired.last_fired_at, secondFire: applied.last_fired_at,
  childCandidatesBefore: kids, childCandidatesAfter: kids2,
  clonesNamedByTheReleaseJob: readClonesFromServerLog(B).clones,
  run: (await q(RUN_SQL, [B]))[0],
});
await shootBothThemes("K2__schedule-card__run_card__settled__change-applied", {
  host: "run_card", runId: B, dbAt: t4, open: () => openRunSchedule(B), fit: SEL.detailColumn,
  note: "After the NEXT real tick: the schedule fired at the time that was saved, not the time it was armed with, and a second child run was cloned by the app.",
});

// ---- (4) Cancel schedule, AND THE DUE BOUNDARY IT MUST NOT FIRE ON -------
//
// A stop is only worth what the next due instant proves. A daily schedule's next
// tick is a day away, so before the stop the schedule is RE-ARMED — with the
// card's own Save changes — to a boundary a few minutes ahead, and the round
// then waits PAST that instant and reads the row back. "No further fire" is
// therefore a due instant that came and went with nothing behind it, not a
// thirty-second gap.
await openRunSchedule(B);
const cronBeforeStopArm = (await q(TRIGGER_SQL, [B]))[0].cron_expression;
await choose(SEL.recurringMinute, STOP_MINUTE);
await settle(900);
await page.locator(SEL.save).first().click();
let rearmed = null;
for (let i = 0; i < 60 && !rearmed; i += 1) {
  await settle(2000);
  const [row] = await q(TRIGGER_SQL, [B]);
  if (row.cron_expression !== cronBeforeStopArm) rearmed = row;
}
if (!rearmed) throw new Error("the schedule did not re-arm to the stop-test boundary");
const dueAt = (() => {
  const d = new Date();
  d.setUTCHours(Number(REC_HOUR), Number(STOP_MINUTE), 0, 0);
  return d;
})();
if (dueAt.getTime() <= Date.now()) throw new Error("the stop-test boundary is already in the past");
const t5 = await stamp("T5", `re-armed to ${rearmed.cron_expression} so the stop has a due instant inside this round (${dueAt.toISOString()})`, {
  cronBefore: cronBeforeStopArm, trigger: rearmed, dueAt: dueAt.toISOString(),
});
const lastFiredBeforeStop = rearmed.last_fired_at;
const clonesBeforeStop = readClonesFromServerLog(B).clones;
const candidatesBeforeStop = await q(CHILD_CANDIDATES_SQL, [TEMPLATE_ID, armedAt, B]);

await openRunSchedule(B);
await page.locator(SEL.cancel).first().click();
await settle(1200);
await page.locator(SEL.confirmDestructive).first().click();
let stopped = null;
for (let i = 0; i < 60 && !stopped; i += 1) {
  await settle(2000);
  const [row] = await q(TRIGGER_SQL, [B]);
  if (row.stopped_at) stopped = row;
}
if (!stopped) throw new Error("Cancel schedule did not stamp stopped_at");
const t6 = await stamp("T6", "Cancel schedule stopped the recurring schedule: stopped_at stamped, enabled false, the scheduler id kept, the run's own status untouched", {
  trigger: stopped, run: (await q(RUN_SQL, [B]))[0],
  clonesNamedByTheReleaseJob: clonesBeforeStop, childCandidates: candidatesBeforeStop,
  dueInstantStillAhead: dueAt.toISOString(),
});
await shootBothThemes("J1__schedule-card__run_card__settled__stopped", {
  host: "run_card", runId: B, dbAt: t6, open: () => openRunSchedule(B), fit: SEL.detailColumn,
  note: "After Cancel schedule: the scheduler is non-editable — the rows read-only and no floor at all. Shot while the schedule's next due instant was still ahead.",
});
await shootBothThemes("J2__schedule-card__chat_thread__settled__stopped", {
  host: "chat_thread", runId: B, dbAt: t6, open: () => openThread(threadB), fit: SEL.cardRoot,
  note: "The same stop, read in the conversation the schedule was stated in: the card's rows are read-only and its floor is gone.",
});

// WAIT PAST THE DUE INSTANT, then read the row back.
const waitUntil = dueAt.getTime() + 90_000;
say(`WAITING past the stopped schedule's due instant ${dueAt.toISOString()} (+90s)`);
while (Date.now() < waitUntil) await settle(10_000);
const afterDue = (await q(TRIGGER_SQL, [B]))[0];
const clonesAfterDue = readClonesFromServerLog(B).clones;
const candidatesAfterDue = await q(CHILD_CANDIDATES_SQL, [TEMPLATE_ID, armedAt, B]);
const t7 = await stamp("T7", "the stopped schedule's due instant came and went: nothing fired", {
  dueAt: dueAt.toISOString(), trigger: afterDue, run: (await q(RUN_SQL, [B]))[0],
  lastFiredBeforeStop, lastFiredAfterDue: afterDue.last_fired_at,
  clonesBeforeStop, clonesAfterDue,
  childCandidatesBefore: candidatesBeforeStop.length, childCandidatesAfter: candidatesAfterDue.length,
});
// COMPARE THE INSTANTS, not the objects. `pg` hands back Date instances, and
// two Dates are never `===` even when they name the same moment — a guard that
// compared them by identity would fire on a schedule that did exactly what it
// should.
const sameInstant = (a, x) => (a == null ? null : new Date(a).toISOString()) === (x == null ? null : new Date(x).toISOString());
if (!sameInstant(afterDue.last_fired_at, lastFiredBeforeStop)) {
  throw new Error("the stopped schedule fired after its due instant");
}
if (clonesAfterDue.length !== clonesBeforeStop.length) throw new Error("the stopped schedule cloned a run after its due instant");

// ---- (5) the canonical cell, re-shot --------------------------------------
const threadC = await stateTheSchedule(`Please schedule ${TEMPLATE_ID} to run once at ${FUTURE_RUN_AT} in the UTC timezone.`);
await page.locator('[data-schedule-option="scheduled"] button').first().click(); await settle(800);
await page.locator(SEL.timezone).first().fill("UTC");
await page.locator(SEL.runAt).first().fill(FUTURE_RUN_AT);
await settle(800);
const C = await confirmAndReadRun();
const cTrigger = (await q(TRIGGER_SQL, [C]))[0];
if (cTrigger.released_at) throw new Error("this cell needs a schedule that has NOT run");
const t8 = await stamp("T8", "a one-off armed for tomorrow — configured, and not run", { trigger: cTrigger, run: (await q(RUN_SQL, [C]))[0] });
await shootBothThemes("S9d-C3__schedule-card__run_card__decided", {
  host: "run_card", runId: C, dbAt: t8, open: () => openRunSchedule(C), fit: SEL.detailColumn, alsoIndexRecord: true,
  note: "Configured and not run, on the run page: the reading S9d-C3 claims, re-shot on this branch. Run now is gone from the surface and the prompt window sits under the scheduler.",
});

// ---- the closing read -----------------------------------------------------
await stamp("T9", "the round's own ledger window and the release job's parentage lines", {
  usageSinceRoundStart: await usageThisRound(),
  clonesNamedByTheReleaseJob: readClonesFromServerLog(B).clones,
  providerEvidence: assertRealChain("the closing read"),
});

writeFileSync(process.env.OUT_RECORDS, `${JSON.stringify(records, null, 2)}\n`);
writeFileSync(process.env.OUT_INDEX_RECORDS, `${JSON.stringify(indexRecords, null, 2)}\n`);
writeFileSync(process.env.OUT_CONTROLS, `${JSON.stringify(controls, null, 2)}\n`);
writeFileSync(process.env.OUT_TIMELINE, `${JSON.stringify({ turnsRefusedOrUnanswered, oneOff: { runId: A, thread: threadA }, recurring: { runId: B, thread: threadB }, configured: { runId: C, thread: threadC }, armedAt, steps: timeline }, null, 2)}\n`);
say("DONE", records.length, "record(s)");
await b.close();
await end();
