// ---------------------------------------------------------------------------
// THE §VI CAPTURE WALK for cinatra#2788 (S9d), driven on the LIVE dev stack.
//
// WHAT IS REAL HERE, stated so a reader does not have to infer it:
//   · the pages are the shipped /chat transcript and the shipped run screen on
//     this lane's dev server;
//   · the card is the shipped `ScheduleProposalCard`, reached through the
//     shipped registry dispatch (chat_thread) and the shipped `TriggerScreen`
//     mount (run_card) — no fixture route and no test harness renders it;
//   · every state change is a PRESS IN THE BROWSER on the card's own controls,
//     which post to the shipped `/api/lifecycle-views/decide` endpoint. This
//     file confirms nothing and adjusts nothing by itself;
//   · every number in every record is measured by the ONE shared recorder
//     (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`) through the page
//     port below, twice, and a screen that moved between the two measurements
//     fails the capture instead of being written down.
//
// THE ONE STAND-IN, NAMED: the `expired` cells. On `main`'s resolver an expired
// proposal token answers `absent` — the vanish defect cinatra#2836 / PR #2837
// fixes — so this branch cannot reach the expired PHASE through the server at
// all. Those two cells therefore intercept the card's own resolve response and
// answer it with the expired body (`triggerScheduleProposalExpiredViewSchema`,
// copied byte-identically from #2837 on this branch). The component, the page,
// the browser and the anchors are real; the SERVER'S ANSWER is the stand-in,
// and the cell name says `standin` in it. Nothing else in this walk is stood in.
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
const CONFIRM = '[data-action="confirm-schedule-proposal"]';
const ADJUST = '[data-action="adjust-schedule-proposal"]';
const CANCEL = '[data-action="cancel-trigger-schedule"]';
const RELEASE = '[data-action="release-trigger-now"]';

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');

const browser = await chromium.launch({ headless: true });
const records = [];
const results = [];
const log = (...a) => console.log("CAP2788", ...a);

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
 * `localStorage.theme`. A context merely asked for `colorScheme: "dark"`
 * renders the LIGHT ground. So the theme is set the way the app itself stores
 * it, before the first paint, and every record carries the class the document
 * actually resolved.
 */
async function open(urlPath, theme, height = 1400) {
  const ctx = await browser.newContext({
    viewport: { width: PLAN.viewportWidth ?? 1228, height },
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
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  const resp = await page.goto(BASE + urlPath, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.waitForLoadState("load").catch(() => {});
  return { ctx, page, pageErrors, status: resp?.status() ?? null };
}

/** The page port the shared recorder reads through. Nothing is decided here. */
function portFor(page) {
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
      const n = await page.locator(CARD_ROOT).count();
      if (n > 0) await page.locator(CARD_ROOT).first().screenshot({ path: abs, scale: "device" });
      else await page.screenshot({ path: abs, fullPage: true, scale: "device" });
    },
  };
}

/** Everything a grader needs to read the picture back, off the live DOM. */
async function observe(page) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return { present: false };
    const rowOf = (kind) => {
      const el = root.querySelector(`[data-schedule-option="${kind}"]`);
      return el ? { chosen: el.getAttribute("data-chosen"), text: (el.innerText || "").replace(/\n{2,}/g, "\n") } : null;
    };
    return {
      present: true,
      rootAttributes: [...root.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => (a.value ? `${a.name}="${a.value}"` : a.name)),
      text: (root.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 1200),
      rows: { immediate: rowOf("immediate"), scheduled: rowOf("scheduled"), recurring: rowOf("recurring") },
      buttons: [...root.querySelectorAll("[data-action]")].map((b) => ({
        action: b.getAttribute("data-action"),
        pressed: b.getAttribute("aria-pressed"),
        disabled: b.hasAttribute("disabled"),
        text: (b.innerText || "").trim(),
      })),
      // §VI: "There is no raw cron field". Measured, not assumed.
      mentionsCron: /cron/i.test(root.innerText || ""),
      themeClass: document.documentElement.className,
    };
  }, CARD_ROOT);
}

/** One recorded cell, written by the shared recorder through the port above. */
async function record(page, cell, { host, state, note, extraAssertions = [] }) {
  const screenshot = path.posix.join(PLAN.dir, `${cell}.png`);
  const rec = await observeCapture({
    page: portFor(page),
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
  log(cell, JSON.stringify({ sha: rec.sha256.slice(0, 12), theme: seen.themeClass, cron: seen.mentionsCron, buttons: seen.buttons }));
  return seen;
}

/**
 * EXTRA anchors, on top of the ones the recorder derives for the host.
 *
 * Each carries the expectation this cell actually makes of it — `present` and
 * `absent` are both MEASURED, so an absence is an observation rather than a
 * silence. `phase` is what separates the three §VI readings from one another.
 */
function anchorsFor(phase, host) {
  const within = CARD_ROOT;
  const A = (selector, expect, scope = "root") => ({ selector, scope, within: scope === "root" ? within : undefined, expect });
  const base = [
    { selector: CARD_ROOT, scope: "frame" },
    A("[data-lifecycle-card-state]", "present"),
    A(`[data-lifecycle-card-host="${host}"]`, "present"),
    A(`[data-lifecycle-card-phase="${phase}"]`, "present"),
  ];
  if (phase === "proposal") {
    return [
      ...base,
      A(ROWS, "present"),
      A('[data-schedule-option="recurring"][data-chosen="true"]', "present"),
      A(FLOOR, "present"),
      A(ADJUST, "present"),
      A(CONFIRM, "present"),
      A(CHROME, "absent"),
      A(EXPIRED, "absent"),
    ];
  }
  if (phase === "expired") {
    return [
      ...base,
      A(EXPIRED, "present"),
      A(ROWS, "present"),
      A(ADJUST, "present"),
      // There is nothing to confirm: the window closed and the token is spent.
      A(CONFIRM, "absent"),
      A(CHROME, "absent"),
    ];
  }
  return [
    ...base,
    A(CHROME, "present"),
    A(CANCEL, "present"),
    A(ROWS, "absent"),
    A(FLOOR, "absent"),
    A(CONFIRM, "absent"),
    A(ADJUST, "absent"),
  ];
}

async function waitForCard(page, phase) {
  await page.locator(`${CARD_ROOT}[data-lifecycle-card-phase="${phase}"]`)
    .first()
    .waitFor({ state: "attached", timeout: 180000 });
  await page.waitForTimeout(2500);
}

/** The expired stand-in: the card's own resolve, answered with #2837's body. */
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
        body: {
          phase: "expired",
          version: 1,
          agentName,
          schedule,
          scheduleCopy,
        },
      }),
    });
  });
}

// ── 1. chat_thread, LIGHT: pending → Adjust → Confirm ───────────────────────
for (const [prefix, theme, thread] of [
  ["A", "light", PLAN.threads.light],
  ["B", "dark", PLAN.threads.dark],
]) {
  const suffix = theme === "dark" ? "__dark" : "";
  const { ctx, page, pageErrors } = await open(thread.chatPath, theme);
  await waitForCard(page, "proposal");
  await record(page, `${prefix}1__schedule-card__chat_thread__pending${suffix}`, {
    host: "chat_thread",
    state: "pending",
    extraAssertions: anchorsFor("proposal", "chat_thread"),
    note:
      "The proposal as it arrives in the transcript: the question, the three option rows with the RECURRING row chosen and owning its fields, the estimated duration, and §VI's floor — Adjust · Confirm. The schedule the reader is deciding on is on the card, which is what the placeholder box this slice retires never showed.",
  });

  // §7 step 3 / §VI: "Adjust opens the same option rows IN PLACE."
  await page.locator(ADJUST).first().click({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await record(page, `${prefix}2__schedule-card__chat_thread__pending__adjust-open${suffix}`, {
    host: "chat_thread",
    state: "pending",
    extraAssertions: [
      ...anchorsFor("proposal", "chat_thread"),
      { selector: `${ADJUST}[aria-pressed="true"]`, scope: "root", within: CARD_ROOT, expect: "present" },
      { selector: '[data-field="recurring-weekday"]:not([disabled])', scope: "root", within: CARD_ROOT, expect: "present" },
    ],
    note:
      "WHAT ADJUST PRODUCES. The same rows, in place, now writable — the weekday buttons, the interval, the hour and the timezone are live and the Adjust control reads pressed. No second form is swapped in and no new card is drawn.",
  });

  // Close the editor again, so Confirm is pressed on the proposal as PROPOSED.
  await page.locator(ADJUST).first().click({ timeout: 60000 });
  await page.waitForTimeout(1000);

  await page.locator(CONFIRM).first().click({ timeout: 60000 });
  await waitForCard(page, "settled");
  await record(page, `${prefix}3__schedule-card__chat_thread__settled${suffix}`, {
    host: "chat_thread",
    state: "decided",
    extraAssertions: anchorsFor("settled", "chat_thread"),
    note:
      "After a real press of Confirm in the same transcript: the card settles IN PLACE into the trigger's own chrome — read-only Trigger configuration, the steps held until the trigger fires, and the quiet controls. Nothing was reloaded and no second card was drawn.",
  });
  log(`${prefix} pageErrors`, JSON.stringify(pageErrors.slice(0, 3)));
  await ctx.close();
}

// ── 2. the IMMEDIATE proposal, confirmed in the chat so the run page has a
//      card to draw at all. Not recorded: its two chat states are the same two
//      photographed above, and one picture cannot prove two screens.
{
  const { ctx, page } = await open(PLAN.threads.immediate.chatPath, "light");
  await waitForCard(page, "proposal");
  await page.locator(CONFIRM).first().click({ timeout: 60000 });
  await waitForCard(page, "settled");
  log("immediate confirmed in the transcript");
  await ctx.close();
}

const consumes = await db.query(
  `SELECT run_id, template_id, consumed_by, consumed_at FROM "${SCHEMA}".trigger_schedule_proposal_consumes ORDER BY consumed_at`,
);
const outbox = await db.query(
  `SELECT run_id, trigger_type, cron_expression, timezone, status FROM "${SCHEMA}".trigger_schedule_install_outbox ORDER BY run_id`,
);
log("CONFIRM WROTE", JSON.stringify({ consumes: consumes.rows, outbox: outbox.rows }));
const immediateRow = outbox.rows.find((r) => r.trigger_type === "immediate");
const runId = immediateRow?.run_id ?? null;
log("run_card run", runId);

// ── 3. run_card: the same component, mounted by the run page's TriggerScreen ─
if (runId) {
  for (const [cell, theme] of [
    ["R1__schedule-card__run_card__settled", "light"],
    ["R2__schedule-card__run_card__settled__dark", "dark"],
  ]) {
    const { ctx, page, pageErrors } = await open(`/agents/${PLAN.agentPath}/${runId}/trigger`, theme);
    await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await record(page, cell, {
      host: "run_card",
      state: "decided",
      extraAssertions: anchorsFor("settled", "run_card"),
      note:
        "The SAME component on the run page, mounted by TriggerScreen under its own host declaration, addressed by a run-scoped ref minted server-side. The run is the one the confirmed proposal created; a run no proposal produced draws no card here at all.",
    });
    log(`${cell} pageErrors`, JSON.stringify(pageErrors.slice(0, 3)));
    await ctx.close();
  }
} else {
  log("NO RUN — run_card cells not captured");
}

// ── 4. the EXPIRED face — the one stand-in, and it is named ─────────────────
for (const [cell, theme] of [
  ["E1__schedule-card__chat_thread__pending__expired-face__standin", "light"],
  ["E2__schedule-card__chat_thread__pending__expired-face__standin__dark", "dark"],
]) {
  // The interception is installed BEFORE the first resolve leaves the page, so
  // the card never draws any other phase in this context.
  const c = await browser.newContext({
    viewport: { width: PLAN.viewportWidth ?? 1228, height: 1400 },
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await c.addCookies(cookiesFor(PLAN.cookie));
  await c.addInitScript((t) => {
    try { window.localStorage.setItem("theme", t); } catch { /* recorded as themeClass */ }
  }, theme === "dark" ? "dark" : "cinatra");
  const p = await c.newPage();
  await standInExpired(p, PLAN.expired.schedule, PLAN.expired.agentName, PLAN.expired.scheduleCopy);
  await p.goto(BASE + PLAN.threads.expired.chatPath, { waitUntil: "domcontentloaded", timeout: 240000 });
  await p.waitForLoadState("load").catch(() => {});
  await waitForCard(p, "expired");
  await record(p, cell, {
    host: "chat_thread",
    state: "pending",
    extraAssertions: anchorsFor("expired", "chat_thread"),
    note:
      "STAND-IN, NAMED: main's resolver answers an expired proposal `absent` (the vanish defect cinatra#2836 / PR #2837 fixes), so this branch cannot reach the expired PHASE through the server. The card, the transcript, the browser and every counted anchor are real; what is stood in is the RESOLVE RESPONSE, answered with the expired body this branch carries byte-identically from #2837. The reading it proves is the plan's: the card STAYS VISIBLE with the schedule it asked about and an Adjust to propose again, and no Confirm floor.",
  });
  await c.close();
}

fs.writeFileSync(RECORDS_OUT, JSON.stringify({ records, results }, null, 2));
await db.end();
await browser.close();
log("DONE", RECORDS_OUT);
