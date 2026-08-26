// SHOOT C7 — the setup run page of a run that has not started.
//
// The walk file beside this driver says where to stand and what to press; this
// driver runs it through the SHIPPED action vocabulary
// (`runWalkAction`, scripts/audit/lib/chat-hitl-capture-driver.mjs) and then
// MEASURES the page rather than describing it: every number in a record here is
// counted off the live page, and the page-controls sidecar is the rows' own
// attributes as the DOM carries them.
//
// The records are NOT canonical-index records, and capture-walk.json says why:
// the index's contract asks every record for `[data-lifecycle-card-host]`, and
// this screen draws no lifecycle card — an absence that is half of what the cell
// proves. Inventing an anchor to satisfy the contract would make the record a
// submission instead of a measurement.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

import { runWalkAction } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";

const BASE = process.env.WALK_BASE;
const RUN_URL = process.env.WALK_RUN_URL;
const DB = process.env.SUPABASE_DB_URL;
const RUN_ID = process.env.WALK_RUN_ID;
const WALK = process.env.WALK_PLAN ?? "evidence/2970-setup-rail/capture-walk.json";
const OUT = process.env.OUT_JSON ?? "evidence/2970-setup-rail/capture-records.json";
for (const [n, v] of Object.entries({ WALK_BASE: BASE, WALK_RUN_URL: RUN_URL, SUPABASE_DB_URL: DB, WALK_RUN_ID: RUN_ID }))
  if (!v) throw new Error(`the capture needs ${n}`);

const plan = JSON.parse(readFileSync(WALK, "utf8"));
const db = new Client({ connectionString: DB });
await db.connect();

/** The rail's rows, as the DOM carries them — the page-controls sidecar. */
const READ_CONTROLS = () => {
  const rows = Array.from(document.querySelectorAll("[data-run-surface-rail-step]"));
  const detail = document.querySelector("[data-run-detail-column]");
  return {
    railColumns: document.querySelectorAll("[data-run-step-rail-column]").length,
    detailColumns: document.querySelectorAll("[data-run-detail-column]").length,
    selectedStep: detail?.getAttribute("data-run-surface-selected-step") ?? null,
    lifecycleCardHosts: document.querySelectorAll("[data-lifecycle-card-host]").length,
    agenticRunProgressPanels: document.querySelectorAll("[data-agentic-run-progress], [data-conformance-id='agentic-run-progress']").length,
    // NAMED FOR WHAT THE SELECTOR ACTUALLY COUNTS. `ScheduleRailStep`'s own row
    // anchors are a DIFFERENT mount from the scheduling form this page draws in
    // its detail column, and a field called "schedulerForms" reading 0 beside a
    // picture of the form is a misleading name, not a wrong number.
    scheduleRailStepAnchors: document.querySelectorAll("[data-schedule-rail-step], [data-conformance-id='schedule-rail-step']").length,
    // The scheduling form itself, measured inside the detail column. The option
    // rows are BUTTONS, not native radios — the radio count is recorded anyway,
    // named for what it counts, so a reader can see that it is zero because the
    // form is not built from native radios and not because the form is absent.
    detailColumnNativeRadioInputs: document.querySelectorAll("[data-run-detail-column] input[type='radio'], [data-run-detail-column] [role='radio']").length,
    detailColumnButtons: Array.from(document.querySelectorAll("[data-run-detail-column] button")).map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12),
    rows: rows.map((el) => ({
      tag: el.tagName.toLowerCase(),
      key: el.getAttribute("data-run-surface-rail-step-key"),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      selected: el.getAttribute("data-run-surface-rail-selected"),
      reached: el.getAttribute("data-run-surface-rail-reached"),
      ariaDisabled: el.getAttribute("aria-disabled"),
      dataAction: el.getAttribute("data-action"),
      nativeDisabled: el.hasAttribute("disabled"),
      tabIndex: el.tabIndex,
    })),
    // WHERE THE RUN SURFACE IS in the picture, in device pixels, so the
    // pixel-diff beside it can answer "did anything inside the run surface
    // change?" as a measurement rather than as a sentence.
    runSurfaceRect: (() => {
      const el = document.querySelector("[data-conformance-id='run-surface']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const d = window.devicePixelRatio;
      return { x0: Math.floor(r.left * d), y0: Math.floor(r.top * d), x1: Math.ceil(r.right * d), y1: Math.ceil(r.bottom * d) };
    })(),
    detailHtmlDigest: null,
  };
};
const READ_DETAIL_HTML = () => document.querySelector("[data-run-detail-column]")?.outerHTML ?? "";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const digestOf = (text) => sha256(Buffer.from(text, "utf8"));

const browser = await chromium.launch();
const live = new Map();
const records = [];
const detailHtml = {};
try {
  for (const step of plan.steps) {
    let open = live.get(step.context);
    if (!open) {
      const declared = plan.contexts[step.context] ?? {};
      const context = await browser.newContext({
        viewport: declared.viewport ?? { width: 1440, height: 900 },
        deviceScaleFactor: declared.deviceScaleFactor ?? 2,
        colorScheme: declared.colorScheme ?? "light",
        baseURL: BASE,
      });
      if (declared.theme) {
        await context.addInitScript((t) => {
          try { window.localStorage.setItem("theme", t); } catch { /* the RECORD says which theme resolved */ }
        }, declared.theme);
      }
      // The session is the operator's, minted through the app's own sign-in.
      const signIn = await context.request.post("/api/auth/sign-in/email", {
        headers: { Origin: BASE },
        data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
      });
      if (!signIn.ok()) throw new Error(`sign-in for context "${step.context}" answered ${signIn.status()}`);
      open = { context, page: await context.newPage() };
      open.page.setDefaultTimeout(300_000);
      open.page.setDefaultNavigationTimeout(300_000);
      live.set(step.context, open);
    }
    const page = open.page;
    if (step.id === "c7-click") {
      detailHtml.before = await page.evaluate(READ_DETAIL_HTML);
      detailHtml.beforeControls = await page.evaluate(READ_CONTROLS);
    }
    for (const action of step.actions ?? []) {
      if (action.action === "click" && action.force) {
        // A FORCED press, and why. The rows under proof carry `aria-disabled`,
        // and Playwright's own actionability treats that as not-enabled — it
        // would wait forever and never deliver the press. A row that is never
        // pressed proves nothing about what pressing it does, so the press is
        // delivered as a real mouse click on the row the page draws, and what
        // the page does with it is then measured.
        await page.locator(action.selector).first().click({ force: true, timeout: 60_000 });
        continue;
      }
      await runWalkAction(page, { ...action, url: action.url === "${WALK_RUN_URL}" ? RUN_URL : action.url });
    }
    if (step.id === "c7-click") {
      detailHtml.after = await page.evaluate(READ_DETAIL_HTML);
      detailHtml.afterControls = await page.evaluate(READ_CONTROLS);
    }
    for (const cell of step.cells ?? []) {
      const controls = await page.evaluate(READ_CONTROLS);
      const detail = await page.evaluate(READ_DETAIL_HTML);
      controls.detailHtmlDigest = digestOf(detail);
      const shot = resolve(cell.screenshot);
      mkdirSync(dirname(shot), { recursive: true });
      const buf = await page.screenshot({ path: shot, fullPage: false });
      const resolvedTheme = await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme") ??
        (document.documentElement.classList.contains("dark") ? "dark" : "light"),
      );
      const dims = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
      const dbAt = (await db.query(
        `SELECT r.status, r.created_at, r.started_at, r.completed_at,
                t.trigger_type, t.scheduled_at, t.timezone, t.released_at,
                (SELECT count(*) FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS review_gates,
                now() AS read_at
           FROM cinatra.agent_runs r
           LEFT JOIN cinatra.agent_run_triggers t ON t.run_id = r.id
          WHERE r.id = $1`, [RUN_ID],
      )).rows[0];
      records.push({
        cell: cell.cell,
        step: step.id,
        theme: cell.theme,
        resolvedTheme,
        framing: cell.framing,
        runId: RUN_ID,
        finalUrl: new URL(page.url()).pathname,
        screenshot: cell.screenshot,
        sha256: sha256(buf),
        px: { width: dims.w * dims.dpr, height: dims.h * dims.dpr, css: `${dims.w}x${dims.h}`, deviceScaleFactor: dims.dpr },
        requires: cell.requires,
        controls,
        dbAt,
        recordedAt: new Date().toISOString(),
        runtime: "dev-runtime",
      });
      console.log(`observed ${cell.cell} — theme ${resolvedTheme}, selected step "${controls.selectedStep}", rows ${controls.rows.length}`);
    }
  }
} finally {
  for (const { context } of live.values()) await context.close();
  await browser.close();
}

const clickProof = {
  detailBeforeDigest: digestOf(detailHtml.before ?? ""),
  detailAfterDigest: digestOf(detailHtml.after ?? ""),
  detailIdentical: (detailHtml.before ?? "") === (detailHtml.after ?? ""),
  selectedBefore: detailHtml.beforeControls?.selectedStep ?? null,
  selectedAfter: detailHtml.afterControls?.selectedStep ?? null,
  rowsBefore: detailHtml.beforeControls?.rows ?? [],
  rowsAfter: detailHtml.afterControls?.rows ?? [],
};
const light = records.find((r) => r.step === "c7-light");
const clicked = records.find((r) => r.step === "c7-click");
clickProof.pixelsIdentical = Boolean(light && clicked && light.sha256 === clicked.sha256);
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ slice: plan.slice, records, clickProof }, null, 2)}\n`);
console.log(`click proof: detail DOM identical=${clickProof.detailIdentical}, pixels identical=${clickProof.pixelsIdentical}, selected ${clickProof.selectedBefore} -> ${clickProof.selectedAfter}`);
console.log(`wrote ${records.length} record(s) -> ${OUT}`);
await db.end();
