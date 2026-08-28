// THE CHANGE REQUEST, TYPED INTO THE REVIEW'S OWN PROMPT WINDOW — the ONE way
// the ratified drawing offers ("app-artifact-review" §VI: "Typing a change
// request into it is how a reviewer requests changes; there is no dedicated
// 'request changes' button"). It is what the run needs for the verification
// card to exist at all: `coreDefault` fires the `verification` checkpoint
// "whenever `changes_requested` occurred"
// (`src/lib/lifecycle/lifecycle-policy.ts`).
//
// Nothing is inserted: the request is typed into the shipped window and sent
// with its own control, and every number below is read back out of the run's
// own rows.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE, DB = process.env.SUPABASE_DB_URL;
const RUN = process.env.WALK_RUN_ID, OUT = process.env.OUT_JSON;
const PAGE = process.env.WALK_REVIEW_PAGE;
const REQUEST = process.env.WALK_CHANGE_REQUEST;
const WAIT_MS = Number(process.env.WALK_REPAIR_WAIT_MS ?? 1200000);
for (const [n, v] of Object.entries({ WALK_BASE: BASE, SUPABASE_DB_URL: DB, WALK_RUN_ID: RUN, OUT_JSON: OUT, WALK_REVIEW_PAGE: PAGE, WALK_CHANGE_REQUEST: REQUEST }))
  if (!v) throw new Error(`the change-request driver needs ${n}`);

const db = new Client({ connectionString: DB }); await db.connect();
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); page.setDefaultTimeout(300_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const timeline = [];
const stamp = (w, x = {}) => { const e = { at: new Date().toISOString(), what: w, ...x }; timeline.push(e); console.log(`  · ${e.at} ${w} ${Object.keys(x).length ? JSON.stringify(x) : ""}`); };
const gates = async () => (await db.query(
  `select id, review_task_id, status, disposition, resolved_at, created_at from cinatra.artifact_review_gates where run_id=$1 order by created_at`, [RUN])).rows;
const verifications = async () => (await db.query(
  `select count(*) n from information_schema.tables where table_schema='cinatra' and table_name like '%verification%'`)).rows[0].n;

await page.goto(PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-conformance-id="review-prompt-window"]', { state: "attached", timeout: 180_000 });
await page.waitForTimeout(8000);
// THE WINDOW IS PORTALLED. `review-prompt-window` is the MOUNT anchor and its own
// element is empty: `HitlConversationPanel` renders into `portalTarget`, so the
// composer this driver types into is found by the drawing's own sentence — the
// placeholder §VI puts on it — rather than inside the anchor.
stamp("the review page is open with its own prompt window (portalled)", { gatesBefore: await gates() });
// AN OBSERVATION, recorded where it was made: the composer this window portals in
// is a contenteditable whose ACCESSIBLE NAME reads "Apply AI suggestion", not the
// sentence §VI puts on this surface. Reported, not worked around — the driver
// types into the composer the page actually draws.
const composerName = await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  return el ? { ariaLabel: el.getAttribute("aria-label"), placeholderSeenOnPage: (document.body.innerText || "").includes("Ask Cinatra about this review") } : null;
});
stamp("the review prompt window's composer, as the page draws it", composerName ?? {});
const box = page.locator('[contenteditable="true"]').first();
const composer = box.locator("xpath=ancestor::form[1]");
const win = (await composer.count()) > 0 ? composer : page.locator("body");
await box.scrollIntoViewIfNeeded().catch(() => {});
await box.click();
await page.keyboard.type(REQUEST, { delay: 8 });
await page.waitForTimeout(1200);
const send = win.locator('button[type="submit"]').first();
if ((await send.count()) > 0) { await send.click(); stamp("the change request was sent with the window's own control"); }
else { await page.keyboard.press("Enter"); stamp("the change request was sent with the window's own Enter"); }

const t0 = Date.now();
let repaired = null, successor = null;
while (Date.now() - t0 < WAIT_MS) {
  const gs = await gates();
  const base = gs.find((g) => g.review_task_id === decodeURIComponent(PAGE.split("/review/")[1] ?? ""));
  if (base && base.status === "resolved" && !repaired) { repaired = base; stamp("THE BASE GATE RESOLVED", { disposition: base.disposition, at: base.resolved_at }); }
  if (gs.length > 1) { successor = gs[gs.length - 1]; stamp("A SUCCESSOR REVIEW GATE IS ON FILE", { reviewTaskId: successor.review_task_id, status: successor.status, createdAt: successor.created_at }); break; }
  await page.waitForTimeout(4000);
}
if (!successor) stamp("NO SUCCESSOR GATE within the window", { windowMs: WAIT_MS, gates: await gates() });

// The verification record, read back through the shipped store's own table.
const vrows = (await db.query(
  `select table_name from information_schema.tables where table_schema='cinatra' and table_name like '%verification%'`)).rows.map((r) => r.table_name);
const vdata = [];
for (const t of vrows) {
  const rows = (await db.query(`select * from cinatra."${t}" limit 20`)).rows;
  vdata.push({ table: t, rows: rows.length, sample: rows.slice(0, 3) });
}
const out = { runId: RUN, baseGate: repaired, successorGate: successor, gates: await gates(), verificationTables: vdata, timeline };
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ baseResolved: repaired?.disposition ?? null, successor: successor?.review_task_id ?? null, verificationTables: vdata.map((v) => `${v.table}=${v.rows}`) }, null, 1));
await db.end(); await b.close();
