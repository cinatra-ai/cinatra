// THE CELLS WITH NO REACHABLE SUBJECT, MEASURED RATHER THAN ASSUMED.
//
// Three cells this round was asked for cannot be photographed from a real run on
// this head. None of them is written off: each is DRIVEN — the surface is opened
// and the anchors are counted — and the count, the run's own timestamps and the
// code fact are recorded together. Nothing is staged and nothing stands in.
//
//   a5  recommendation_hold PENDING on page_gate_region
//   a6/a7  verification_summary ADVISORY on chat_thread / run_card / page_gate_region
//   a8  the run-progress placeholder on page_gate_region
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL, OUT = process.env.OUT_JSON;
const SURFACES = (process.env.WALK_SURFACES ?? "").split(";").map((s) => s.trim()).filter(Boolean);
for (const [n, v] of Object.entries({ WALK_BASE: BASE, SUPABASE_DB_URL: DB, OUT_JSON: OUT }))
  if (!v) throw new Error(`the measurement driver needs ${n}`);

const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(240_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });

const counts = [];
for (const entry of SURFACES) {
  const [label, url] = entry.split("=");
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(14000);
  const read = await page.evaluate(() => ({
    path: location.pathname,
    notFoundPanel: (document.body.innerText || "").includes("404 — Page not found"),
    conversationLists: document.querySelectorAll("[data-conversation-list]").length,
    hosts: Array.from(document.querySelectorAll("[data-lifecycle-card-host]")).map((e) => e.getAttribute("data-lifecycle-card-host")),
    cards: Array.from(document.querySelectorAll("[data-lifecycle-card]")).map((e) => ({ kind: e.getAttribute("data-lifecycle-card"), host: e.getAttribute("data-lifecycle-card-host"), state: e.getAttribute("data-lifecycle-card-state") })),
    verificationCards: document.querySelectorAll('[data-lifecycle-card="verification_summary"]').length,
    holdCards: document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length,
    holdPending: Array.from(document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]')).filter((e) => e.getAttribute("data-lifecycle-card-state") === "pending").length,
    placeholders: document.querySelectorAll('[data-conformance-id="review-gate-placeholder"]').length,
    slots: Array.from(document.querySelectorAll("[data-run-review-slot]")).map((e) => e.getAttribute("data-run-review-slot")),
  }));
  counts.push({ label, url, read });
  console.log(`${label}: ${JSON.stringify({ verification: read.verificationCards, holdPending: read.holdPending, placeholders: read.placeholders, notFound: read.notFoundPanel })}`);
}

// The run-order measurement behind a5: when the hold was held, and when the
// review gate that a review page needs was minted.
const runs = (await db.query(
  `select id, status, source_type, human_present, parent_run_id, created_at from cinatra.agent_runs order by created_at`)).rows;
const holdRows = (await db.query(
  `select run_id, count(*) n from cinatra.run_selected_skill_revisions group by run_id`)).rows;
const reviewGates = (await db.query(
  `select run_id, review_task_id, status, disposition, created_at, resolved_at from cinatra.artifact_review_gates order by created_at`)).rows;
const audits = (await db.query(`select count(*) n from cinatra.artifact_verification_records`)).rows[0].n;
const repairs = (await db.query(`select id, status, route, successor_gate_id, attempt, created_at, updated_at from cinatra.lifecycle_repair order by created_at`)).rows;

const out = { surfaces: counts, runs, skillRevisionsByRun: holdRows, reviewGates, verificationRecordCount: Number(audits), lifecycleRepairs: repairs, at: new Date().toISOString() };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ verificationRecordCount: out.verificationRecordCount, repairs: repairs.length, reviewGates: reviewGates.length }, null, 1));
await db.end(); await b.close();
