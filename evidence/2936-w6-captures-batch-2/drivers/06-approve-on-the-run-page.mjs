// APPROVE, PRESSED ON THE RUN PAGE'S OWN DECISION BAR — the terminal decision
// app-artifact-review §VI puts on the gate ("Approve (primary) … terminal — they
// resolve the gate and hand the run its outcome"), taken on the card the run
// page mounts in its own review slot, not on the review page and not through an
// action this driver invents.
//
// Nothing is inserted and no status is written by hand: the press is the shipped
// control, and the settled reading is read back off the live DOM and out of the
// gate's own row.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const RUN = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const RUN_PAGE = process.env.WALK_RUN_PAGE;
const RATIONALE = process.env.WALK_RATIONALE ?? "";
for (const [n, v] of Object.entries({ WALK_BASE: BASE, SUPABASE_DB_URL: DB, WALK_RUN_ID: RUN, OUT_JSON: OUT, WALK_RUN_PAGE: RUN_PAGE }))
  if (!v) throw new Error(`the approve driver needs ${n}`);

const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const timeline = [];
const stamp = (w, x = {}) => { const e = { at: new Date().toISOString(), what: w, detail: x }; timeline.push(e); console.log(`  · ${e.at} ${w} ${Object.keys(x).length ? JSON.stringify(x) : ""}`); };
const gate = async () => (await db.query(
  `select id, review_task_id, status, disposition, resolved_by, resolved_at from cinatra.artifact_review_gates where run_id=$1 order by created_at desc limit 1`, [RUN])).rows[0];

await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-lifecycle-card="artifact_review_gate"]', { timeout: 240_000 });
await page.waitForTimeout(9000);
const before = await page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="artifact_review_gate"]');
  return card ? { host: card.getAttribute("data-lifecycle-card-host"), state: card.getAttribute("data-lifecycle-card-state"), bars: card.querySelectorAll('[data-conformance-id="review-decision-bar"]').length, outcome: card.querySelectorAll("[data-review-outcome]").length } : null;
});
stamp("the run page draws the gate in its own review slot", { card: before, gate: await gate() });

const bar = page.locator('[data-conformance-id="review-decision-bar"]').first();
if (RATIONALE) {
  const note = page.locator("#review-rationale, textarea").first();
  if ((await note.count()) > 0) await note.fill(RATIONALE).catch(() => {});
}
const approve = bar.getByRole("button", { name: /^\s*Approve\s*$/i }).first();
await approve.scrollIntoViewIfNeeded().catch(() => {});
await approve.click({ timeout: 120000 });
stamp("Approve was pressed on the run page's own decision bar");

for (let i = 0; i < 60; i += 1) {
  const g = await gate();
  if (g?.status === "resolved") { stamp("THE GATE RESOLVED", g); break; }
  await page.waitForTimeout(3000);
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
const after = await page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="artifact_review_gate"]');
  return card ? {
    host: card.getAttribute("data-lifecycle-card-host"),
    state: card.getAttribute("data-lifecycle-card-state"),
    bars: card.querySelectorAll('[data-conformance-id="review-decision-bar"]').length,
    settled: card.querySelectorAll('[data-conformance-id="review-gate-settled"]').length,
    outcome: Array.from(card.querySelectorAll("[data-review-outcome]")).map((e) => e.getAttribute("data-review-outcome")),
    text: (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 260),
  } : null;
});
stamp("the settled card on the run page", after ?? {});
const out = { runId: RUN, before, after, gate: await gate(), timeline };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ resolved: out.gate?.status ?? null, disposition: out.gate?.disposition ?? null, state: after?.state ?? null }, null, 1));
await db.end(); await b.close();
