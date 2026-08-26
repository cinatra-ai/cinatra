// ---------------------------------------------------------------------------
// THE 2026-08-26 RE-SHOOT OF THIS SET'S C7, AND THE THREE CELLS cinatra#2970
// ADDS BESIDE IT (PR #2975).
//
// WHY A SECOND DRIVER RATHER THAN AN EDIT TO `page-control.mjs`. That driver
// shoots ONE stage at ONE url in two themes and presses nothing; the cells this
// round owes have to PRESS things between shutters — Continue on the scheduler
// step, and the rail rows the ruling is about — and they have to read the rail's
// own row attributes, which C7's original record never carried because the rail
// did not exist on that screen. `page-control.mjs` is therefore left BYTE-
// UNCHANGED and this file states its own contract:
//
//   • It writes the SAME record shape into the SAME `page-controls.json`, with
//     the same five `visible` anchors for a C7 record, so the re-shot record can
//     be read directly against the one it replaces (rail 0 / detail 0 -> 1 / 1).
//   • Every count is read off the LIVE page through the recorder's own
//     `playwrightPage` port — the same reader `observeCapture` measures a walk
//     cell with — never described.
//   • It writes NO verdict. The verdicts are graded from the pixels, on the pull
//     request and in README.md.
//   • These are still PAGE CONTROLS, not records of
//     `scripts/ci/chat-hitl-capture-index.json`: every record of that index
//     asserts `[data-lifecycle-card-host="<host>"]` and this screen draws no
//     lifecycle card, which is half of what the cells prove. The index is
//     untouched by this round.
//
// EVERY CAPTURE IS THE FULL BROWSER WINDOW: `page.screenshot()` with no clip,
// no element handle and no fullPage, 1440x900 at deviceScaleFactor 2.
//
// NOTHING HERE WRITES TO THE DATABASE. The runs are the app's own, created by
// its own dispatch; this driver opens their pages, presses what the plan says,
// and reads the rows back.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";

const PLAN_PATH = process.argv[2];
const BASE = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const OUT_JSON = process.env.PC_OUT_JSON ?? "evidence/2788-s9d-rework/page-controls.json";
for (const [n, v] of Object.entries({ plan: PLAN_PATH, WALK_BASE: BASE, SUPABASE_DB_URL: DB }))
  if (!v) throw new Error(`the re-shoot driver needs ${n}`);

const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));

/** The five anchors a C7 record has always carried, plus the two the two-column
 *  frame adds. Named here, counted off the live page. */
const DEFAULT_ANCHORS = [
  '[data-conformance-id="run-step-rail-column"]',
  "[data-run-detail-column]",
  'form button[type="submit"]',
  "[data-lifecycle-card-host]",
  '[data-conformance-id="agentic-run-progress"]',
];

/** The rail's rows and the detail column, as the DOM carries them. */
const READ_CONTROLS = () => {
  const rows = Array.from(document.querySelectorAll("[data-run-surface-rail-step]"));
  const detail = document.querySelector("[data-run-detail-column]");
  return {
    railColumns: document.querySelectorAll("[data-run-step-rail-column]").length,
    detailColumns: document.querySelectorAll("[data-run-detail-column]").length,
    selectedStep: detail?.getAttribute("data-run-surface-selected-step") ?? null,
    lifecycleCardHosts: document.querySelectorAll("[data-lifecycle-card-host]").length,
    agenticRunProgressPanels: document.querySelectorAll(
      "[data-agentic-run-progress], [data-conformance-id='agentic-run-progress']",
    ).length,
    detailColumnButtons: Array.from(document.querySelectorAll("[data-run-detail-column] button"))
      .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 14),
    detailColumnHeadings: Array.from(
      document.querySelectorAll("[data-run-detail-column] h1, [data-run-detail-column] h2, [data-run-detail-column] h3, [data-run-detail-column] label"),
    )
      .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 14),
    detailColumnTextLength: (detail?.textContent ?? "").replace(/\s+/g, " ").trim().length,
    rows: rows.map((el) => {
      // THE SETTLED ROW IS READ AT ITS OWN CIRCLE (cinatra#2975, round 8). The
      // ratified drawing's resolved-gate history row is "the completed circle in
      // place of the numeral, the title unhighlighted", so the reading that
      // decides it is what the INDICATOR holds: a numeral, or the check glyph
      // with no text at all. Both are read off the live node the row draws, not
      // described — `railStepIndicatorText` is "" exactly when the numeral is
      // gone, and `railStepIndicatorHasCheckGlyph` is true exactly when the
      // glyph replaced it.
      const indicator = el.querySelector('[data-conformance-id="run-surface-rail-indicator"]');
      return {
        tag: el.tagName.toLowerCase(),
        key: el.getAttribute("data-run-surface-rail-step-key"),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        selected: el.getAttribute("data-run-surface-rail-selected"),
        reached: el.getAttribute("data-run-surface-rail-reached"),
        settled: el.getAttribute("data-run-surface-rail-settled"),
        railStepIndicatorText: (indicator?.textContent ?? "").replace(/\s+/g, " ").trim(),
        railStepIndicatorHasCheckGlyph: Boolean(indicator?.querySelector("svg")),
        ariaDisabled: el.getAttribute("aria-disabled"),
        dataAction: el.getAttribute("data-action"),
        nativeDisabled: el.hasAttribute("disabled"),
        tabIndex: el.tabIndex,
      };
    }),
    /* THE WORDING THE PAGE USES FOR THIS STEP (cinatra#3006, round 8). The
       merged main says it in two places a reader can check without opening a
       component: the breadcrumb and the tab strip say "Schedule", never
       "Trigger", and no "Trigger configuration" card is drawn anywhere. All
       three are counted off the live page. */
    pageTabs: Array.from(document.querySelectorAll('[role="tab"]'))
      .map((t) => (t.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
    breadcrumbTrail: Array.from(
      document.querySelectorAll('nav[aria-label="breadcrumb"] li, [data-slot="breadcrumb-item"]'),
    )
      .map((t) => (t.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
    /** How often the literal word "Trigger" appears in what a person can read. */
    triggerWordOccurrences: ((document.body.innerText ?? "").match(/\bTrigger\b/g) ?? []).length,
    /** A "Trigger configuration" card anywhere on the page. */
    triggerConfigurationCards: Array.from(document.querySelectorAll("h1,h2,h3,h4,p,span,div")).filter(
      (n) => (n.textContent ?? "").replace(/\s+/g, " ").trim() === "Trigger configuration",
    ).length,
    /** Where the run surface sits in the picture, in device pixels. */
    runSurfaceRect: (() => {
      const el = document.querySelector("[data-conformance-id='run-surface']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const d = window.devicePixelRatio;
      return { x0: Math.floor(r.left * d), y0: Math.floor(r.top * d), x1: Math.ceil(r.right * d), y1: Math.ceil(r.bottom * d) };
    })(),
  };
};
const READ_DETAIL_HTML = () => document.querySelector("[data-run-detail-column]")?.outerHTML ?? "";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const digestOf = (t) => sha256(Buffer.from(t, "utf8"));

const db = new Client({ connectionString: DB });
await db.connect();
const readRun = async (runId) =>
  runId
    ? (
        await db.query(
          `SELECT r.status, r.created_at, r.started_at, r.completed_at,
                  t.trigger_type, t.scheduled_at, t.timezone, t.released_at,
                  (SELECT count(*) FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS review_gates,
                  now() AS read_at
             FROM cinatra.agent_runs r
             LEFT JOIN cinatra.agent_run_triggers t ON t.run_id = r.id
            WHERE r.id = $1`,
          [runId],
        )
      ).rows[0] ?? null
    : null;

const browser = await chromium.launch();
const produced = [];
const proofs = [];
try {
  for (const cell of plan.cells) {
    for (const theme of cell.themes ?? ["light", "dark"]) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        baseURL: BASE,
      });
      await ctx.addInitScript((t) => {
        try { window.localStorage.setItem("theme", t); } catch { /* the record says which theme RESOLVED */ }
      }, theme === "dark" ? "dark" : "light");
      const signIn = await ctx.request.post("/api/auth/sign-in/email", {
        headers: { Origin: BASE },
        data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
      });
      if (!signIn.ok()) throw new Error(`sign-in answered ${signIn.status()}`);
      const page = await ctx.newPage();
      page.setDefaultTimeout(300_000);
      page.setDefaultNavigationTimeout(300_000);
      page.on("pageerror", (e) => console.log(`  pageerror: ${String(e).slice(0, 160)}`));
      await page.goto(cell.url, { waitUntil: "domcontentloaded" });
      if (cell.waitFor) await page.waitForSelector(cell.waitFor, { timeout: 420_000 });
      await page.waitForTimeout(cell.settleMs ?? 4000);

      const before = { controls: await page.evaluate(READ_CONTROLS), detail: await page.evaluate(READ_DETAIL_HTML) };
      for (const action of cell.actions ?? []) {
        if (action.action === "click") {
          // A FORCED press where the plan says so, and why: the rows under
          // proof carry `aria-disabled`, which Playwright's own actionability
          // treats as not-enabled — it would wait forever and never deliver the
          // press, and a row that is never pressed proves nothing about what
          // pressing it does. The press is a real mouse click on the row the
          // page draws.
          await page.locator(action.selector).first().click({ force: Boolean(action.force), timeout: 120_000 });
        } else if (action.action === "clickText") {
          await page.getByRole("button", { name: action.name, exact: true }).first().click({ timeout: 120_000 });
        } else if (action.action === "waitForSelector") {
          await page.waitForSelector(action.selector, { timeout: 420_000 });
        } else if (action.action === "waitForTimeout") {
          await page.waitForTimeout(action.ms);
        } else if (action.action === "goto") {
          await page.goto(action.url, { waitUntil: "domcontentloaded" });
        } else {
          throw new Error(`unknown action ${action.action}`);
        }
      }
      const after = { controls: await page.evaluate(READ_CONTROLS), detail: await page.evaluate(READ_DETAIL_HTML) };

      const file = `evidence/2788-s9d-rework/captures/${cell.control}__${cell.name}__${theme}.png`;
      mkdirSync(dirname(resolve(file)), { recursive: true });
      const buf = await page.screenshot({ path: resolve(file) });
      const box = page.viewportSize();
      const resolvedTheme = await page.evaluate(
        () =>
          document.documentElement.getAttribute("data-theme") ??
          (document.documentElement.classList.contains("dark") ? "dark" : "light"),
      );
      const reader = playwrightPage(page);
      const visible = {};
      for (const sel of cell.anchors ?? DEFAULT_ANCHORS) visible[sel] = await reader.countVisible(sel);

      produced.push({
        control: cell.control,
        theme,
        framing: "window",
        build: "development",
        screenshot: file,
        sha256: sha256(buf),
        pixels: `${box.width * 2}x${box.height * 2}`,
        finalUrlPath: await reader.url(),
        resolvedTheme,
        visible,
        capturedAt: new Date().toISOString(),
        record: "NONE — not a lifecycle host; filed as the page control (see README.md)",
        runId: cell.runId ?? null,
        requires: cell.requires,
        controls: after.controls,
        dbAt: await readRun(cell.runId),
        runtime: "dev-runtime",
      });
      if ((cell.actions ?? []).length > 0) {
        proofs.push({
          control: cell.control,
          theme,
          what: cell.proofNote ?? null,
          detailBeforeDigest: digestOf(before.detail),
          detailAfterDigest: digestOf(after.detail),
          detailIdentical: before.detail === after.detail,
          selectedBefore: before.controls.selectedStep,
          selectedAfter: after.controls.selectedStep,
          rowsBefore: before.controls.rows,
          rowsAfter: after.controls.rows,
          detailHeadingsBefore: before.controls.detailColumnHeadings,
          detailHeadingsAfter: after.controls.detailColumnHeadings,
        });
      }
      console.log(
        `${cell.control} ${theme} -> ${file} · rail ${after.controls.railColumns} / detail ${after.controls.detailColumns} · selected "${after.controls.selectedStep}" · rows ${after.controls.rows.map((r) => r.text).join(" | ")}`,
      );
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await db.end();
}

// SPLICE, keeping every other control's records byte-identical and in a
// DECLARED order rather than in the order the shutters happened to fire.
const prior = JSON.parse(readFileSync(OUT_JSON, "utf8"));
const replaced = new Set(produced.map((r) => r.control));
const merged = [...prior.filter((r) => !replaced.has(r.control)), ...produced];
const order = plan.order ?? [];
merged.sort((a, b) => {
  const ia = order.indexOf(a.control);
  const ib = order.indexOf(b.control);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.theme === b.theme ? 0 : a.theme === "light" ? -1 : 1;
});
writeFileSync(OUT_JSON, `${JSON.stringify(merged, null, 2)}\n`);
if (process.env.PC_PROOF_JSON) writeFileSync(process.env.PC_PROOF_JSON, `${JSON.stringify(proofs, null, 2)}\n`);
console.log(`wrote ${produced.length} record(s) into ${OUT_JSON} (${merged.length} total)`);
