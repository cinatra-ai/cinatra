// THE CELLS THE SHIPPED RECORDER REFUSES, SHOT AND RECORDED BESIDE THE INDEX —
// never inside it.
//
// At this head the recorder ADMITS `agent_hitl_screen` and takes its `pending`
// records. It still refuses the kind's `decided` records, and the refusal is a
// contradiction between two of its own rules rather than anything about the
// picture:
//
//   scripts/ci/lib/capture-record-contract.mjs — `settledIsAbsence: true` on this
//     kind, so `requiredAssertionsFor` emits NO root-scoped requirement for a
//     `decided` capture (the card's root is owed ABSENT, and there is no root to
//     count inside);
//   scripts/audit/lib/chat-hitl-capture-recorder.mjs `captureRequirementsFor` —
//     the audit tier's own root-scoped addition is skipped for the same reason;
//   `observeCapture` — with no root-scoped spec, `rootSelector` is null, no card
//     instance is resolved, and the record carries no `instance`;
//   `validateCaptureRecord` — at the audit tier, a record whose `declaredKind`
//     HAS a card root must carry an `instance`, and refuses:
//     "a chat_thread record must carry the `instance` its card-scoped counts were
//      read from — without it the counts describe whichever card led the DOM".
//
// So this driver takes the picture and writes the same record shape into the
// lane's own twin, labelled as a lane shot. NOTHING is changed to get past the
// refusal: the canonical index holds only the records the shipped recorder
// itself wrote.
//
//   env: WALK_BASE, LANE_ACCOUNT, LANE_SECRET, SUPABASE_DB_URL, WALK_RUN_ID,
//        RECORDS_OUT, CELLS_JSON
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const OUT = process.env.RECORDS_OUT;
const RUN = process.env.WALK_RUN_ID;
const CELLS = JSON.parse(process.env.CELLS_JSON);
const RUNTIME = process.env.LANE_RUNTIME ?? "dev-runtime";
for (const [n, v] of Object.entries({ WALK_BASE: APP, RECORDS_OUT: OUT, WALK_RUN_ID: RUN }))
  if (!v) throw new Error(`the refused-cell driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const ANCHORS = [
  { selector: '[data-lifecycle-card="agent_hitl_screen"]', scope: "frame", expect: "absent" },
  { selector: '[data-conformance-id="hitl-screen-fields"]', scope: "frame", expect: "absent" },
  { selector: '[data-conformance-id="agent-hitl-screen-card"]', scope: "frame", expect: "absent" },
  { selector: '[data-action="submit-hitl-screen"]', scope: "frame", expect: "absent" },
  { selector: "[data-conversation-list]", scope: "frame", expect: "present" },
];

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const browser = await chromium.launch();
const records = [];
for (const cell of CELLS) {
  const context = await browser.newContext({
    baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: cell.theme,
  });
  await context.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch { /* the record says which theme resolved */ } }, cell.theme);
  const si = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
  if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.setDefaultNavigationTimeout(300_000);
  await page.goto(cell.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-list]", { timeout: 300_000 });
  await page.waitForTimeout(cell.settleMs ?? 9000);
  const measure = () => page.evaluate((anchors) => {
    const painted = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      assertions: anchors.map((a) => {
        const all = Array.from(document.querySelectorAll(a.selector));
        return { selector: a.selector, scope: a.scope, count: all.length, visible: all.filter(painted).length, expect: a.expect, frame: "main" };
      }),
      url: location.pathname + location.search,
      resolvedTheme: document.documentElement.classList.contains("dark") || document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
    };
  }, ANCHORS);
  const before = await measure();
  const shutterAt = new Date().toISOString();
  const abs = resolve(cell.screenshot);
  mkdirSync(dirname(abs), { recursive: true });
  await page.screenshot({ path: abs, fullPage: false });
  const after = await measure();
  const drift = before.assertions.filter((a, i) => a.count !== after.assertions[i].count || a.visible !== after.assertions[i].visible);
  if (drift.length > 0) throw new Error(`capture "${cell.cell}" is not stable: ${drift.map((d) => d.selector).join(", ")}`);
  const sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
  const dbAt = (await db.query(
    `SELECT id, status, started_at, completed_at, lifecycle_moment, lifecycle_card_kind, input_params, a2a_task_id, now() AS read_at
       FROM cinatra.agent_runs WHERE id=$1`, [RUN])).rows[0] ?? null;
  records.push({
    cell: cell.cell,
    declaredHost: cell.declaredHost,
    declaredKind: "agent_hitl_screen",
    declaredState: "decided",
    finalUrl: before.url,
    build: "development",
    framing: "window",
    screenshot: cell.screenshot,
    sha256,
    capturedAt: shutterAt,
    assertions: before.assertions,
    recordedBy: "cinatra-lifecycle-capture-recorder@1 (lane shot — the SHIPPED recorder refuses a `decided` record of this kind; see the header of this driver and README.md)",
    registered: false,
    refusal:
      "a chat_thread record must carry the `instance` its card-scoped counts were read from — " +
      "without it the counts describe whichever card led the DOM",
    runtime: RUNTIME,
    theme: { declared: cell.theme, resolved: before.resolvedTheme },
    runId: RUN,
    dbAt,
    requires: cell.requires ?? null,
  });
  console.log(`shot ${cell.cell} -> ${cell.screenshot} sha256 ${sha256.slice(0, 16)}… (${before.assertions.map((a) => `${a.selector}=${a.count}`).join(", ")})`);
  await context.close();
}
await browser.close();
await db.end();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
const existing = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { records: [] }; } })();
const by = new Map((existing.records ?? []).map((r) => [r.cell, r]));
for (const r of records) by.set(r.cell, r);
writeFileSync(OUT, `${JSON.stringify({ ...existing, records: [...by.values()] }, null, 2)}\n`);
console.log(`wrote ${records.length} lane record(s) -> ${OUT}`);
