// ---------------------------------------------------------------------------
// THE §VI CAPTURE WALK for cinatra#2788 (S9d), driven on the LIVE dev stack —
// REWORKED against PLAN: Agents Lifecycle (A) §7.2, §7.4
// "As designed", §9).
//
// WHAT IS REAL HERE, stated so a reader does not have to infer it:
//   · the pages are the shipped /chat transcript, the shipped run detail and
//     the shipped review page on this lane's dev server;
//   · the card is the shipped `ScheduleProposalCard`, reached through the
//     shipped registry dispatch (chat_thread) and the shipped `ScheduleRailStep`
//     rail row (run_card, page_gate_region) — no fixture route and no test
//     harness renders it;
//   · every state change is a PRESS IN THE BROWSER on the card's own controls,
//     which post to the shipped `/api/lifecycle-views/decide` endpoint, and the
//     route is RELOADED after each decision so the settled reading is the
//     server's answer to a fresh request rather than a live component's
//     optimistic state. This file confirms nothing and saves nothing by itself;
//   · every number in every record is measured by the ONE shared recorder
//     (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`) through the page
//     port below, and a screen that moved between the two measurements fails
//     the capture instead of being written down.
//
// THE ONE STAND-IN, NAMED: the `expired` cells. On this branch's resolver an
// expired proposal token still answers `absent` — the vanish defect cinatra#2836
// fixes, which is that issue's scope and not this one's — so this branch cannot
// reach the expired PHASE through the server at all. Those two cells therefore
// intercept the card's own resolve response and answer it with the expired body.
// The component, the page, the browser and the anchors are real; the SERVER'S
// ANSWER is the stand-in, and the cell name says `standin` in it. Nothing else
// in this walk is stood in.
//
// COUNTING RULES (identical to the other lanes', restated so every number is
// re-derivable): page/frame = document.querySelectorAll(sel).length; root =
// root.matches(sel) + root.querySelectorAll(sel).length.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { observeCapture } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const pw = await import(process.env.CAP_PLAYWRIGHT);
const chromium = pw.chromium ?? pw.default?.chromium;

const BASE = process.env.CAP_BASE;
const REPO_ROOT = process.env.CAP_REPO_ROOT;
const RECORDS_OUT = process.env.CAP_RECORDS_OUT;
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const CARD_ROOT = '[data-lifecycle-card="trigger_schedule_proposal"]';
const ROWS = '[data-conformance-id="schedule-option-rows"]';
const FLOOR = '[data-conformance-id="schedule-proposal-floor"]';
const CHROME = '[data-conformance-id="scheduled-run-chrome"]';
const EXPIRED = '[data-conformance-id="schedule-proposal-expired"]';
const ARMED = '[data-conformance-id="schedule-armed-summary"]';
const CONFIRM = '[data-action="confirm-schedule-proposal"]';
const SAVE = '[data-action="save-schedule-changes"]';
const ADJUST = '[data-action="adjust-schedule-proposal"]';
const CANCEL = '[data-action="cancel-trigger-schedule"]';
const RELEASE = '[data-action="release-trigger-now"]';
const RAIL_STEP = '[data-conformance-id="schedule-rail-step"]';
const OPEN_STEP = '[data-action="open-schedule-step"]';
const REVIEW_CARD = '[data-lifecycle-card="artifact_review_gate"]';

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');

const browser = await chromium.launch({ headless: true });
// RESUMABLE. A Turbopack dev server under memory pressure restarts itself, and a
// restart in the middle of a twelve-cell walk used to cost the whole walk. Every
// recorded cell is flushed to disk as it lands and re-read on the next launch,
// so a re-run photographs only what is still missing. Nothing is ever taken from
// the file except the fact that a cell was already recorded — the record itself
// was written by the shared recorder, in the run that took the picture.
let records = [];
let results = [];
if (fs.existsSync(RECORDS_OUT)) {
  try {
    const prior = JSON.parse(fs.readFileSync(RECORDS_OUT, "utf8"));
    records = prior.records ?? [];
    results = prior.results ?? [];
  } catch {
    records = [];
    results = [];
  }
}
const done = new Set(records.map((r) => r.cell));
const log = (...a) => console.log("CAP2788", ...a);
const flush = () =>
  fs.writeFileSync(RECORDS_OUT, JSON.stringify({ records, results }, null, 2));

function cookiesFor(cookie) {
  return cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
  });
}

/**
 * Open a page in a given THEME.
 *
 * The app does not take its theme from `prefers-color-scheme`: `src/app/
 * providers.tsx` mounts next-themes with `attribute="class"` over the two named
 * themes `cinatra` (light) and `dark`, and next-themes reads the choice from
 * `localStorage.theme`. So the theme is set the way the app itself stores it,
 * before the first paint, and every record carries the class the document
 * actually resolved.
 */
async function newContext(theme) {
  const ctx = await browser.newContext({
    viewport: { width: PLAN.viewportWidth ?? 1440, height: PLAN.viewportHeight ?? 1500 },
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await ctx.addCookies(cookiesFor(PLAN.cookie));
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem("theme", t);
    } catch {
      /* a context that refuses storage renders the default theme, and the
         record's themeClass says so rather than the cell name claiming it. */
    }
  }, theme === "dark" ? "dark" : "cinatra");
  return ctx;
}

/**
 * Navigate, with retries.
 *
 * A Turbopack dev server restarts itself on an extension-tree change and can be
 * refusing connections for a few seconds while it does. That is a property of
 * the RUNTIME, not of the screen under test, so a navigation that lands on an
 * empty response is retried rather than recorded — and if it never lands, the
 * walk fails loudly instead of writing a record of a blank page.
 */
async function goto(page, urlPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const resp = await page.goto(BASE + urlPath, {
        waitUntil: "domcontentloaded",
        timeout: 300000,
      });
      await page.waitForLoadState("load").catch(() => {});
      return resp?.status() ?? null;
    } catch (error) {
      lastError = error;
      log("navigation retry", attempt, urlPath, String(error).slice(0, 120));
      await page.waitForTimeout(15000);
    }
  }
  throw lastError;
}

async function open(ctx, urlPath) {
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  const status = await goto(page, urlPath);
  return { page, pageErrors, status };
}

/** The page port the shared recorder reads through. Nothing is decided here. */
function portFor(page, shotSelector) {
  const countIn = (rootSel, index, sel, visibleOnly) =>
    page.evaluate(
      ({ rootSel: r, index: i, sel: q, visibleOnly: v }) => {
        const painted = (el) => {
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const root = r === null ? null : document.querySelectorAll(r)[i];
        const scope = r === null ? document : root;
        if (!scope) return 0;
        const hits = [
          ...(r !== null && scope.matches?.(q) ? [scope] : []),
          ...scope.querySelectorAll(q),
        ];
        return v ? hits.filter(painted).length : hits.length;
      },
      { rootSel, index, sel, visibleOnly },
    );
  return {
    url: async () => {
      const u = new URL(page.url());
      return u.pathname + (u.search || "");
    },
    count: (sel) => countIn(null, 0, sel, false),
    countVisible: (sel) => countIn(null, 0, sel, true),
    frame: async () => null,
    identifyWithin: (sel) =>
      page.evaluate(
        (q) =>
          [...document.querySelectorAll(q)].map((el) =>
            Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
          ),
        sel,
      ),
    pinWithin: async (sel, index) => ({
      count: (q) => countIn(sel, index, q, false),
      countVisible: (q) => countIn(sel, index, q, true),
    }),
    screenshot: async (abs) => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (shotSelector === null) {
        await page.screenshot({ path: abs, fullPage: true, scale: "device" });
        return;
      }
      const n = await page.locator(shotSelector).count();
      if (n > 0) await page.locator(shotSelector).first().screenshot({ path: abs, scale: "device" });
      else await page.screenshot({ path: abs, fullPage: true, scale: "device" });
    },
  };
}

/** Everything a grader needs to read the picture back, off the live DOM. */
async function observe(page) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    const rail = document.querySelector('[data-conformance-id="schedule-rail-step"]');
    const railText = rail ? (rail.innerText || "").split("\n")[0] : null;
    // The rail rows, in the order they are painted — the ONE observation the
    // "above 1 Review" requirement is graded on.
    const railRows = [...document.querySelectorAll('[data-conformance-id="schedule-rail-step"], [data-slot="stepper-item"]')]
      .map((el) => (el.innerText || "").replace(/\n+/g, " ").trim().slice(0, 60))
      .filter(Boolean);
    const base = {
      railPresent: !!rail,
      railLabel: railText,
      railRows,
      reviewCardsInGateRegion: document.querySelectorAll(
        '[data-lifecycle-card="artifact_review_gate"]',
      ).length,
      scheduleCardsInGateRegion: [
        ...document.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ].filter((el) => el.closest('[data-conformance-id="schedule-rail-step"]') === null).length,
      themeClass: document.documentElement.className,
    };
    if (!root) return { ...base, present: false };
    const rowOf = (kind) => {
      const el = root.querySelector(`[data-schedule-option="${kind}"]`);
      return el
        ? { chosen: el.getAttribute("data-chosen"), text: (el.innerText || "").replace(/\n{2,}/g, "\n") }
        : null;
    };
    return {
      ...base,
      present: true,
      rootAttributes: [...root.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => (a.value ? `${a.name}="${a.value}"` : a.name)),
      text: (root.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 1400),
      rows: { immediate: rowOf("immediate"), scheduled: rowOf("scheduled"), recurring: rowOf("recurring") },
      // EDITABILITY, MEASURED. The plan says "the option rows are editable as they
      // stand", so the record carries whether the fields are actually live.
      editableFields: [...root.querySelectorAll("[data-field]")].map((f) => ({
        field: f.getAttribute("data-field"),
        disabled: f.hasAttribute("disabled") || f.getAttribute("aria-disabled") === "true",
      })),
      buttons: [...root.querySelectorAll("[data-action]")].map((b) => ({
        action: b.getAttribute("data-action"),
        pressed: b.getAttribute("aria-pressed"),
        disabled: b.hasAttribute("disabled"),
        text: (b.innerText || "").trim(),
      })),
      // §VI: "There is no raw cron field". Measured, not assumed.
      mentionsCron: /cron/i.test(root.innerText || ""),
    };
  }, CARD_ROOT);
}

/** One recorded cell, written by the shared recorder through the port above. */
async function record(page, cell, { host, state, note, extraAssertions = [], shot = CARD_ROOT }) {
  const screenshot = path.posix.join(PLAN.dir, `${cell}.png`);
  const rec = await observeCapture({
    page: portFor(page, shot),
    cell,
    declaredHost: host,
    kind: "trigger_schedule_proposal",
    state,
    screenshot,
    build: "development",
    extraAssertions,
    repoRoot: REPO_ROOT,
  });
  rec.note = note;
  rec.runtime = PLAN.runtime;
  const seen = await observe(page);
  rec.themeClass = seen.themeClass ?? null;
  records.push(rec);
  results.push({ cell, sha256: rec.sha256, assertions: rec.assertions, observed: seen });
  done.add(cell);
  flush();
  log(cell, JSON.stringify({ sha: rec.sha256.slice(0, 12), theme: seen.themeClass, cron: seen.mentionsCron, buttons: seen.buttons, rail: seen.railRows }));
  return seen;
}

/**
 * EXTRA anchors, on top of the ones the recorder derives for the host.
 *
 * Each carries the expectation this cell actually makes of it — `present` and
 * `absent` are both MEASURED, so an absence is an observation rather than a
 * silence. `phase` is what separates the three §VI readings from one another,
 * and the ABSENCE of `adjust-schedule-proposal` is asserted on every cell,
 * because §7.2's floor is defined partly by what is NOT on it.
 */
function anchorsFor(phase, host) {
  const within = CARD_ROOT;
  const A = (selector, expect, scope = "root") => ({ selector, scope, within: scope === "root" ? within : undefined, expect });
  const pageHost = host === "run_card" || host === "page_gate_region";
  const base = [
    { selector: CARD_ROOT, scope: "frame" },
    A("[data-lifecycle-card-state]", "present"),
    A(`[data-lifecycle-card-host="${host}"]`, "present"),
    A(`[data-lifecycle-card-phase="${phase}"]`, "present"),
    // The plan's floor, on every single cell: there is no Adjust control anywhere.
    A(ADJUST, "absent"),
  ];
  if (phase === "proposal" || phase === "expired") {
    return [
      ...base,
      A(ROWS, "present"),
      A(FLOOR, "present"),
      A(CONFIRM, "present"),
      A(SAVE, "absent"),
      A(CHROME, "absent"),
      A(EXPIRED, phase === "expired" ? "present" : "absent"),
      // The rows are LIVE — the positive half of "editable as they stand", measured.
      A('[data-field="recurring-timezone"]:not([disabled])', "present"),
    ];
  }
  // settled
  return [
    ...base,
    // §7.2: the same rows, the armed schedule, Save changes.
    A(ROWS, "present"),
    A(ARMED, "present"),
    A(SAVE, "present"),
    A(CONFIRM, "absent"),
    A(EXPIRED, "absent"),
    // §7.2: the trigger's chrome is the PAGE step's, never the
    // conversation's.
    A(CHROME, pageHost ? "present" : "absent"),
    A(CANCEL, pageHost ? "present" : "absent"),
  ];
}

/**
 * Wait for a PHASE by POLLING the DOM, not by `locator.waitFor`.
 *
 * The chat surface holds a live stream open, so Playwright's auto-waiting reads
 * the page as perpetually navigating and a locator wait can sit past its own
 * timeout without ever sampling the DOM. Polling `document.querySelector` asks
 * the only question this walk actually has — is the phase drawn yet — and says
 * what it saw when it gives up.
 */
async function waitForCard(page, phase, timeoutMs = 600000) {
  const started = Date.now();
  for (;;) {
    const seen = await page
      .evaluate(
        (sel) => document.querySelector(sel)?.getAttribute("data-lifecycle-card-phase") ?? null,
        CARD_ROOT,
      )
      .catch(() => null);
    if (seen === phase) break;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`phase "${phase}" never drawn — the card reads "${seen}" after ${timeoutMs}ms`);
    }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2500);
}

/**
 * A REAL PRESS, dispatched on the element the reader would press.
 *
 * `locator.click()` auto-waits for the page to stop navigating, and the chat
 * surface never does — so the press is issued directly, after asserting the
 * control is present and enabled. It is the same event handler either way; what
 * is skipped is Playwright's stability heuristic, not the button.
 */
async function clickIn(page, selector) {
  await waitForSelector(page, selector);
  const ok = await page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el || el.hasAttribute("disabled")) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, selector);
  if (!ok) throw new Error(`control "${selector}" is absent or disabled — nothing was pressed`);
}

/** Poll for a selector, for the same reason `waitForCard` polls. */
async function waitForSelector(page, selector, timeoutMs = 600000) {
  const started = Date.now();
  for (;;) {
    const n = await page.evaluate((q) => document.querySelectorAll(q).length, selector).catch(() => 0);
    if (n > 0) break;
    if (Date.now() - started > timeoutMs) throw new Error(`selector "${selector}" never appeared`);
    await page.waitForTimeout(1000);
  }
}

/** The expired stand-in: the card's own resolve, answered with the expired body. */
async function standInExpired(page, schedule, agentName, scheduleCopy) {
  await page.route("**/api/lifecycle-views/resolve", async (route) => {
    const post = route.request().postData() ?? "";
    if (!post.includes("trigger_schedule_proposal")) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "trigger_schedule_proposal",
        state: { state: "settled" },
        body: { phase: "expired", version: 1, agentName, schedule, scheduleCopy },
      }),
    });
  });
}

// ── 1. chat_thread — the proposal, then the SAME card after a real Confirm ──
for (const [prefix, theme, thread] of [
  ["A", "light", PLAN.threads.light],
  ["B", "dark", PLAN.threads.dark],
]) {
  const suffix = theme === "dark" ? "__dark" : "";
  const pendingCell = `${prefix}1__schedule-card__chat_thread__pending${suffix}`;
  const settledCell = `${prefix}2__schedule-card__chat_thread__settled${suffix}`;
  if (done.has(pendingCell) && done.has(settledCell)) {
    log("skip (already recorded)", pendingCell, settledCell);
    continue;
  }
  const ctx = await newContext(theme);
  const { page, pageErrors } = await open(ctx, thread.chatPath);
  if (done.has(pendingCell)) {
    // A re-run whose first pass pressed Confirm and then lost the server: the
    // proposal is already spent, so this pass photographs only what it owes.
    log("resuming at the settled cell", settledCell);
  } else {
  await waitForCard(page, "proposal");
  await record(page, pendingCell, {
    host: "chat_thread",
    state: "pending",
    extraAssertions: anchorsFor("proposal", "chat_thread"),
    note:
      "PLAN §7.2 — the proposal as it arrives in the transcript: the question, the three option rows with the RECURRING row chosen and owning its fields, the estimated duration, and a floor that holds Confirm and nothing else. The rows are LIVE on first paint (the record's editableFields shows every field undisabled) and there is no Adjust control anywhere on the card.",
  });

  // A REAL PRESS on the card's own Confirm, then the ROUTE IS RELOADED so the
  // settled reading is the server's answer to a fresh request.
  await clickIn(page, CONFIRM);
  }
  await waitForCard(page, "settled");
  // THE ROUTE IS RELOADED, as a fresh navigation rather than a soft reload, so
  // the settled reading is what the server answers a new request — not what the
  // component happened to be holding when the decision landed.
  await goto(page, thread.chatPath);
  await waitForCard(page, "settled");
  await record(page, settledCell, {
    host: "chat_thread",
    state: "decided",
    extraAssertions: anchorsFor("settled", "chat_thread"),
    note:
      "PLAN §7.2 and §7.4 step 4 — after a real press of Confirm in the same transcript, and after a full route reload: NO second card. The same card, in the same place, showing the armed schedule in the SAME option rows, with Save changes to re-arm. Cancel trigger and Release now are absent — the plan puts them on the run page's schedule step, not in the conversation.",
  });
  log(`${prefix} pageErrors`, JSON.stringify(pageErrors.slice(0, 3)));
  await ctx.close();
}

// ── 2. the PAGE proposal, confirmed in the chat so the two page surfaces have
//      a schedule to draw at all. Not recorded: its two chat states are the
//      two photographed above, and one picture cannot prove two screens.
{
  const already = await db.query(
    `SELECT count(*)::int AS n FROM "${SCHEMA}".trigger_schedule_proposal_consumes`,
  );
  // Idempotent on a re-run: the page surfaces need ONE armed schedule, and the
  // consume row is the durable record that one exists.
  if ((already.rows[0]?.n ?? 0) < 3) {
    const ctx = await newContext("light");
    const { page } = await open(ctx, PLAN.threads.page.chatPath);
    await waitForCard(page, "proposal");
    await clickIn(page, CONFIRM);
    await waitForCard(page, "settled");
    log("page-surface proposal confirmed in the transcript");
    await ctx.close();
  } else {
    log("page-surface schedule already armed by an earlier pass");
  }
}

const consumes = await db.query(
  `SELECT run_id, template_id, consumed_by, consumed_at FROM "${SCHEMA}".trigger_schedule_proposal_consumes ORDER BY consumed_at`,
);
const triggers = await db.query(
  `SELECT run_id, trigger_type, cron_expression, timezone, released_at FROM "${SCHEMA}".agent_run_triggers ORDER BY run_id`,
);
log("CONFIRM WROTE", JSON.stringify({ consumes: consumes.rows, triggers: triggers.rows }));
const runId = consumes.rows[consumes.rows.length - 1]?.run_id ?? null;
log("page-surface run", runId);

// ── 3. the two PAGE hosts — the schedule as a STEP IN THE RAIL ──────────────
let reviewTaskId = null;
if (runId) {
  // The review gate the review page needs, written by the SHIPPED writers
  // through the development seed route (plan §11.2). It creates no run and no
  // schedule; it hangs review material on the run the confirmed proposal made.
  const seeded = await fetch(`${BASE}/api/development/lifecycle-seed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CAP_SEED_TOKEN}`,
      Origin: BASE,
      Cookie: PLAN.cookie,
    },
    body: JSON.stringify({
      fixture: "repairVerification",
      orgId: PLAN.orgId,
      actorId: PLAN.userId,
      runId,
    }),
  });
  const seedBody = await seeded.json().catch(() => null);
  log("SEED review gate", seeded.status, JSON.stringify(seedBody).slice(0, 400));
  if (seedBody?.successorTaskId) {
    fs.writeFileSync(
      process.env.CAP_REVIEW_STATE ?? `${RECORDS_OUT}.review.json`,
      JSON.stringify({ runId, successorTaskId: seedBody.successorTaskId }, null, 2),
    );
  }
  // `repairVerification` ends on a PENDING successor gate — the review the page
  // is reached by. Its own task id is what the route takes.
  reviewTaskId = seedBody?.successorTaskId ?? null;
  if (!reviewTaskId && fs.existsSync(process.env.CAP_REVIEW_STATE ?? `${RECORDS_OUT}.review.json`)) {
    // A re-run after a dev-server restart: the gate this walk seeded is already
    // there, so it is re-used rather than seeded twice.
    reviewTaskId = JSON.parse(fs.readFileSync(process.env.CAP_REVIEW_STATE ?? `${RECORDS_OUT}.review.json`, "utf8")).successorTaskId;
    log("SEED review gate reused from the prior pass", reviewTaskId);
  }

  for (const [cell, theme] of [
    ["R1__schedule-card__run_card__settled", "light"],
    ["R2__schedule-card__run_card__settled__dark", "dark"],
  ]) {
    if (done.has(cell)) {
      log("skip (already recorded)", cell);
      continue;
    }
    const ctx = await newContext(theme);
    const { page, pageErrors } = await open(ctx, `/agents/${PLAN.agentPath}/${runId}`);
    await waitForSelector(page, RAIL_STEP);
    // A REAL PRESS: "open that step to see the configuration or change it".
    await clickIn(page, OPEN_STEP);
    await waitForCard(page, "settled");
    await record(page, cell, {
      host: "run_card",
      state: "decided",
      shot: null,
      extraAssertions: [
        ...anchorsFor("settled", "run_card"),
        { selector: RAIL_STEP, scope: "frame", expect: "present" },
        { selector: RELEASE, scope: "root", within: CARD_ROOT, expect: "present" },
      ],
      note:
        "PLAN §7.2 step 5 on the run page — the schedule is a DEDICATED STEP in the left step rail, opened by a real press, above the run's other steps and above the Review step. Inside it: the trigger's own chrome (Trigger configuration, Steps held until trigger fires), the same option rows showing the armed schedule, and the floor with Save changes, Cancel trigger and Release now. The gate region draws no schedule card.",
    });
    log(`${cell} pageErrors`, JSON.stringify(pageErrors.slice(0, 3)));
    await ctx.close();
  }
}

if (runId && reviewTaskId) {
  for (const [cell, theme] of [
    ["P1__schedule-card__page_gate_region__settled", "light"],
    ["P2__schedule-card__page_gate_region__settled__dark", "dark"],
  ]) {
    if (done.has(cell)) {
      log("skip (already recorded)", cell);
      continue;
    }
    const ctx = await newContext(theme);
    const { page, pageErrors } = await open(
      ctx,
      `/agents/${PLAN.agentPath}/${runId}/review/${reviewTaskId}`,
    );
    await waitForSelector(page, RAIL_STEP);
    await clickIn(page, OPEN_STEP);
    await waitForCard(page, "settled");
    await record(page, cell, {
      host: "page_gate_region",
      state: "decided",
      shot: null,
      extraAssertions: [
        ...anchorsFor("settled", "page_gate_region"),
        { selector: RAIL_STEP, scope: "frame", expect: "present" },
        { selector: REVIEW_CARD, scope: "frame", expect: "present" },
      ],
      note:
        "PLAN §7.2 step 5 on the review page — the schedule is a STEP in the left rail, ABOVE the Review step, and the gate region beside it holds the REVIEW CARD ALONE. The two are never drawn together as cards, which is the composition the plan forbids and the one the retired page_gate_region mount used to draw.",
    });
    log(`${cell} pageErrors`, JSON.stringify(pageErrors.slice(0, 3)));
    await ctx.close();
  }
} else {
  log("NO REVIEW GATE — page_gate_region cells not captured", JSON.stringify({ runId, reviewTaskId }));
}

// ── 4. the EXPIRED face — the one stand-in, and it is named ─────────────────
for (const [cell, theme] of [
  ["E1__schedule-card__chat_thread__pending__expired-face__standin", "light"],
  ["E2__schedule-card__chat_thread__pending__expired-face__standin__dark", "dark"],
]) {
  if (done.has(cell)) {
    log("skip (already recorded)", cell);
    continue;
  }
  const ctx = await newContext(theme);
  const page = await ctx.newPage();
  await standInExpired(page, PLAN.expired.schedule, PLAN.expired.agentName, PLAN.expired.scheduleCopy);
  await goto(page, PLAN.threads.expired.chatPath);
  await waitForCard(page, "expired");
  await record(page, cell, {
    host: "chat_thread",
    state: "pending",
    extraAssertions: anchorsFor("expired", "chat_thread"),
    note:
      "PLAN §7.2 step 2 on the expired face. STAND-IN, NAMED: this branch's resolver still answers an expired proposal `absent` (the vanish defect cinatra#2836 owns), so the expired PHASE cannot be reached through the server here. The card, the transcript, the browser and every counted anchor are real; what is stood in is the RESOLVE RESPONSE. The reading it proves is the plan's: the card STAYS VISIBLE, its rows are EDITABLE as they stand, and the floor is Confirm — to propose again. There is no Adjust control.",
  });
  await ctx.close();
}

flush();
await db.end();
await browser.close();
log("DONE", RECORDS_OUT);
