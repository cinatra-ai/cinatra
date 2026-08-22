// ---------------------------------------------------------------------------
// THE CANDIDATE-DRIFT WALK for cinatra#2893, driven on the LIVE dev stack.
//
// WHY A DRIVER OF ITS OWN. The other capture cells on this branch are static
// reads: open a page, wait, photograph. The zero-chip settled reading is not
// reachable that way, because the state it draws is produced by a RACE that has
// to be run: a hold parks on a candidate set, the set is retired underneath it,
// and the human then settles the hold the row is still showing. The shipped
// skip action re-derives the candidate set at settle time, finds nothing, and
// writes the run-level marker with no per-skill row beside it. That is the
// state — and the only honest way to photograph it is to CAUSE it.
//
// WHAT IS REAL HERE, STATED SO A READER DOES NOT HAVE TO INFER IT:
//   · the page is the shipped run screen on this lane's dev server;
//   · the row is the shipped `RunRecommendationChipRow`, mounted by the shipped
//     `RecommendationHoldCard` under `LifecycleCardSurfaceProvider host="run_card"`;
//   · the SKIP is the row's own per-chip Skip, pressed in the browser, which
//     calls the shipped `skipRunRecommendationAction` — no action is invoked
//     directly, and nothing is written into the decision tables by this file;
//   · the DRIFT is the one thing this driver does to the world, and it does it
//     the way an operator would: it removes the agent's skill assignments
//     through the same table the assignment surface writes, between the moment
//     the row is on screen and the moment it is settled.
//
// COUNTING RULES (identical to capture.mjs, restated so every number is
// re-derivable): page/frame = document.querySelectorAll(sel).length; root =
// root.matches(sel) + root.querySelectorAll(sel).length.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// THE ONE SHARED RECORDER writes every record here. It is not merely imitated:
// the counting, the instance pin, the stability re-measure and the record shape
// all come from it, so `recordedBy` naming it is a fact rather than a label.
// What this file supplies is the SCENARIO and a page port over Playwright.
import { observeCapture } from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const pw = await import(process.env.CAP_PLAYWRIGHT);
const chromium = pw.chromium ?? pw.default?.chromium;

const BASE = process.env.CAP_BASE;
const REPO_ROOT = process.env.CAP_REPO_ROOT;
const RECORDS_OUT = process.env.CAP_RECORDS_OUT;
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');

const browser = await chromium.launch({ headless: true });
const records = [];
const results = [];
const log = (...a) => console.log("DRIFT2893", ...a);

function cookiesFor(cookie) {
  return cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
  });
}

/**
 * Open a run screen in a given THEME.
 *
 * The app does not take its theme from `prefers-color-scheme`: `src/app/
 * providers.tsx` mounts next-themes with `attribute="class"` over the two named
 * themes `cinatra` (light) and `dark`, and next-themes reads the choice from
 * `localStorage.theme`. A browser context asked for `colorScheme: "dark"`
 * therefore renders the LIGHT ground and produces a picture byte-identical to
 * the light one — which is why the theme is set here the way the app itself
 * stores it, before the first paint, and the record carries the class the
 * document actually resolved.
 */
async function openRun(runId, theme, height) {
  const ctx = await browser.newContext({
    viewport: { width: PLAN.viewportWidth ?? 1228, height: height ?? 1200 },
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
  const url = `${BASE}/agents/${PLAN.agentPath}/${runId}`;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.waitForLoadState("load").catch(() => {});
  return { ctx, page, pageErrors, status: resp?.status() ?? null };
}

/**
 * THE PAGE PORT the shared recorder reads through.
 *
 * The recorder is deliberately ignorant of Playwright: it asks a port for counts,
 * for painted counts, for the attributes of every element matching a root
 * selector, for a pinned root, and for a screenshot. Everything below is a thin
 * adapter — no counting rule and no record field is decided here.
 */
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
    if (!root) return { present: false, chips: [] };
    const panel = root.querySelector("[data-recommendation-outcome-panel]");
    return {
      present: true,
      rootAttributes: [...root.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => (a.value ? `${a.name}="${a.value}"` : a.name)),
      text: (root.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 900),
      chips: [...root.querySelectorAll("[data-recommendation-chip]")].map((el) => ({
        skillId: el.getAttribute("data-skill-id"),
        mark: el.getAttribute("data-chip-mark"),
      })),
      buttons: [...root.querySelectorAll("button")].map((b) => b.getAttribute("data-skill-action")),
      panel: panel
        ? {
            conformanceId: panel.getAttribute("data-conformance-id"),
            outcome: panel.getAttribute("data-recommendation-outcome"),
            className: panel.getAttribute("class"),
            text: (panel.innerText || "").replace(/\n{2,}/g, "\n"),
          }
        : null,
      themeClass: document.documentElement.className,
    };
  }, CARD_ROOT);
}

/**
 * Press the row's own Skip on EVERY chip, one chip at a time.
 *
 * The §V row releases only when every chip carries a decision (`decideChip`),
 * and pressing a chip does NOT remove its controls — so a loop that always
 * clicks the FIRST Skip on the page decides chip one over and over and never
 * releases anything. The Skip pressed here is therefore scoped to each chip in
 * turn, by the chip's own skill id, which is what a reader does.
 */
async function skipEveryChip(page) {
  const skillIds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-recommendation-chip]")].map((el) =>
      el.getAttribute("data-skill-id"),
    ),
  );
  let pressed = 0;
  for (const skillId of skillIds) {
    const btn = page.locator(
      `[data-recommendation-chip][data-skill-id="${skillId}"] [data-skill-action="skip"]`,
    );
    if ((await btn.count()) === 0) continue;
    await btn.first().click({ timeout: 30000 });
    pressed += 1;
    await page.waitForTimeout(600);
  }
  await page
    .locator('[data-run-recommendation-settled="true"]')
    .first()
    .waitFor({ state: "attached", timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  return pressed;
}

/** One recorded cell, written by the shared recorder through the port above. */
async function record(page, cell, { declaredState, note, extraAssertions = [] }) {
  const screenshot = path.posix.join(PLAN.dir, `${cell}.png`);
  const rec = await observeCapture({
    page: portFor(page),
    cell,
    declaredHost: "run_card",
    kind: "recommendation_hold",
    state: declaredState,
    screenshot,
    build: "development",
    extraAssertions,
    repoRoot: REPO_ROOT,
  });
  rec.note = note;
  rec.runtime = PLAN.runtime;
  const seen = await observe(page);
  records.push(rec);
  results.push({ cell, sha256: rec.sha256, assertions: rec.assertions, observed: seen });
  log(cell, JSON.stringify({ sha: rec.sha256.slice(0, 12), panel: seen.panel, chips: seen.chips }));
  return seen;
}

// EXTRA anchors, on top of the ones the recorder derives for this host.
//
// They are ADDITIONS, never replacements, and each one is written down with the
// expectation this cell actually makes of it — `present` and `absent` are both
// MEASURED, so an absence is an observation rather than a silence.
//
// `captureRequirementsFor` derives a state-keyed set for chat_thread ONLY, so on
// this host the card root, the card's own state declaration and the host
// declaration inside the root are supplied here — the same three the canonical
// contract asks a decided capture for.
//
// THE LAST TWO ARE THE WHOLE POINT OF THIS BRANCH. `[data-recommendation-chip]`
// and `[data-recommendation-outcome-panel]` are what separate the two settled
// readings from each other: the per-chip control owes chips and no panel, the
// zero-chip cell owes a panel and no chip. Stated as expectations rather than
// left to the eye, so the two cells cannot be confused for one another.
const KIND_ANCHORS = [
  { selector: CARD_ROOT, scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root", within: CARD_ROOT },
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "root", within: CARD_ROOT },
];
const CONTROLS = ['[data-skill-action="confirm"]', '[data-skill-action="adjust"]', '[data-skill-action="skip"]'];

/** @param {"chips"|"panel"} reading — which settled face this cell photographs. */
function anchorsFor({ decided, reading }) {
  return [
    ...KIND_ANCHORS,
    ...CONTROLS.map((selector) => ({
      selector,
      scope: "root",
      within: CARD_ROOT,
      expect: decided ? "absent" : "present",
    })),
    {
      selector: "[data-recommendation-chip]",
      scope: "root",
      within: CARD_ROOT,
      expect: reading === "panel" ? "absent" : "present",
    },
    {
      selector: "[data-recommendation-outcome-panel]",
      scope: "root",
      within: CARD_ROOT,
      expect: reading === "panel" ? "present" : "absent",
    },
  ];
}

// ── 1. THE CONTROL RUN: settled per chip, with the assignments still standing.
{
  const { ctx, page } = await openRun(PLAN.perchipRunId, "light", 1200);
  await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 120000 });
  await page.waitForTimeout(4000);
  await record(page, PLAN.cells.perchipHeld, {
    declaredState: "pending",
    extraAssertions: anchorsFor({ decided: false, reading: "chips" }),
    note: "Control run, held: the shipped chip row on the run screen, one chip per assigned skill, each carrying its own Confirm / Adjust / Skip.",
  });
  const pressed = await skipEveryChip(page);
  log("perchip skip presses", pressed);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await record(page, PLAN.cells.perchipSettled, {
    declaredState: "decided",
    extraAssertions: anchorsFor({ decided: true, reading: "chips" }),
    note: "Control run, settled: the candidate set survived to settle time, so the recorded set names skills and the row draws the §V PER-CHIP settled faces. This is the reading the zero-chip addition does NOT change.",
  });
  await ctx.close();
}

// ── 2. THE DRIFT RUN. Held first, then the candidates retired underneath it,
//      then settled through the row's own Skip.
{
  const { ctx, page } = await openRun(PLAN.driftRunId, "light", 1200);
  await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 120000 });
  await page.waitForTimeout(4000);
  // NO RECORD FOR THE HELD ROW HERE, DELIBERATELY. This run is held on the same
  // three candidates as the control above, so its held row renders the SAME
  // BYTES — a second picture of it would be the identical image filed under a
  // second cell name, which the evidence gate refuses (`index/duplicate-image`)
  // for the right reason: one picture cannot prove two screens. The control's
  // held cell is what "before the drift" looks like, and it is the same row.
  // The page is still loaded and waited on, because the drift has to land while
  // the row is genuinely on screen.
  const heldChips = await observe(page);
  log("drift run held (not recorded — identical to the control's held row)",
    JSON.stringify({ chips: heldChips.chips.map((c) => c.skillId) }));

  // THE DRIFT ITSELF — the agent's skill assignments retired while the row is
  // on screen. This is the only write this driver makes, and it makes it
  // through the assignment table the shipped assignment surface owns.
  const del = await db.query(
    `DELETE FROM "${SCHEMA}".custom_skill_assignments WHERE agent_id = $1`,
    [PLAN.agentId],
  );
  log("DRIFT applied — assignments removed", del.rowCount);

  const pressed = await skipEveryChip(page);
  log("drift skip presses", pressed);

  const marker = await db.query(
    `SELECT run_id, candidate_count FROM "${SCHEMA}".run_recommendation_skips WHERE run_id = $1`,
    [PLAN.driftRunId],
  );
  const rejected = await db.query(
    `SELECT count(*)::int AS n FROM "${SCHEMA}".run_rejected_recommendations WHERE run_id = $1`,
    [PLAN.driftRunId],
  );
  const selected = await db.query(
    `SELECT count(*)::int AS n FROM "${SCHEMA}".run_selected_skill_revisions WHERE run_id = $1`,
    [PLAN.driftRunId],
  );
  log(
    "EVIDENCE",
    JSON.stringify({
      marker: marker.rows[0] ?? null,
      rejectedRows: rejected.rows[0].n,
      selectedRows: selected.rows[0].n,
    }),
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 240000 });
  await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await record(page, PLAN.cells.driftSettled, {
    declaredState: "decided",
    extraAssertions: anchorsFor({ decided: true, reading: "panel" }),
    note: "THE READING UNDER TEST. The hold settled after its candidates were retired: the run-level skip marker is on record with candidate_count 0 and no per-skill row beside it, so the recorded set names no skill and §V's outcome panel is drawn in place of the chips.",
  });
  await ctx.close();

  // The same settled state, in the dark theme.
  const dark = await openRun(PLAN.driftRunId, "dark", 1200);
  await dark.page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 120000 }).catch(() => {});
  await dark.page.waitForTimeout(4000);
  await record(dark.page, PLAN.cells.driftSettledDark, {
    declaredState: "decided",
    extraAssertions: anchorsFor({ decided: true, reading: "panel" }),
    note: "The same settled zero-chip card in the dark theme — the panel's tokens resolve to the dark ground and the reading is the same.",
  });
  await dark.ctx.close();
}

fs.writeFileSync(RECORDS_OUT, JSON.stringify({ records, results }, null, 2));
await db.end();
await browser.close();
log("DONE", RECORDS_OUT);
