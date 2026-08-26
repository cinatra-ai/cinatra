// ANSWER THE RUN'S SKILLS QUESTION ON THE CARD ITSELF, on the setup run page's
// recommendation step (cinatra#2970, PR #2975 round 7).
//
// The press is the person's press, on the one shipped recommendation card the
// step opens. Nothing here writes a park, a decision or a run row: the app's own
// action releases the hold and dispatches the run, and this driver reads back
// what the app did.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const RUN_ID = process.env.WALK_RUN_ID;
const RUN_PAGE = process.env.WALK_RUN_PAGE;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: APP, WALK_RUN_ID: RUN_ID, WALK_RUN_PAGE: RUN_PAGE, SUPABASE_DB_URL: DB, OUT_JSON: OUT }))
  if (!v) throw new Error(`the confirm driver needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const readState = async () => (await db.query(
  `SELECT r.status, r.started_at, r.completed_at,
          (SELECT status FROM cinatra.lifecycle_continuation_park p WHERE p.run_id = r.id AND p.checkpoint='recommendation') AS park,
          (SELECT count(*) FROM cinatra.agent_run_triggers t WHERE t.run_id = r.id) AS triggers,
          (SELECT count(*) FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS gates,
          now() AS read_at
     FROM cinatra.agent_runs r WHERE r.id = $1`, [RUN_ID])).rows[0];
const before = await readState();
console.log(`before: status=${before.status} park=${before.park} triggers=${before.triggers} gates=${before.gates}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const signIn = await ctx.request.post("/api/auth/sign-in/email", {
  headers: { Origin: APP },
  data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET },
});
if (!signIn.ok()) { console.log(`FAIL sign-in ${signIn.status()}`); process.exit(1); }
const page = await ctx.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(300_000);
await page.goto(RUN_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-run-surface-rail-step-key="recommendation"]');
await page.waitForTimeout(4000);
await page.locator('[data-run-surface-rail-step-key="recommendation"]').first().click();
await page.waitForSelector('[data-lifecycle-card="recommendation_hold"]', { timeout: 180_000 });
await page.waitForTimeout(3000);
const pressedAt = new Date().toISOString();
await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
console.log("PASS pressed Confirm on the recommendation card, in the run detail column");
let after = before;
for (let i = 0; i < 90; i += 1) {
  await page.waitForTimeout(2000);
  after = await readState();
  if (after.park !== "parked" && after.status !== before.status) break;
}
console.log(`after: status=${after.status} park=${after.park} triggers=${after.triggers} gates=${after.gates} started=${after.started_at}`);
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({ before, pressedAt, after }, null, 2)}\n`);
await db.end();
await browser.close();
