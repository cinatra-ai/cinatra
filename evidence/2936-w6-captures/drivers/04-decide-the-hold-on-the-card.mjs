// THE FOUR SKILLS, DECIDED ON THE CARD IN THE CHAT — Confirm, Adjust, Confirm,
// Skip, each pressed on that chip's OWN affordance (`data-skill-id` names the
// chip; nothing is pressed by position). Adjust opens the chip's own sheet, and
// the decision is taken there on its own control.
//
// Nothing is written by hand: the presses are the shipped controls, and the
// settled row is read back off the live DOM and out of the run's own rows.
import { chromium } from "@playwright/test";
import { Client } from "pg";

const BASE = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const THREAD = process.env.WALK_THREAD_URL;
// "<skillId>=<confirm|adjust|skip>[:<sheet control>]", in the order pressed.
const PLAN = (process.env.WALK_DECISIONS ?? "").split(";").map((s) => s.trim()).filter(Boolean);
if (!BASE || !DB || !THREAD || PLAN.length === 0) throw new Error("needs WALK_BASE, SUPABASE_DB_URL, WALK_THREAD_URL, WALK_DECISIONS");

const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.setDefaultTimeout(240_000);
await page.request.post("/api/auth/sign-in/email", { headers: { Origin: BASE }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
await page.goto(THREAD, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-lifecycle-card="recommendation_hold"]');
await page.waitForTimeout(9000);

const readRow = () => page.evaluate(() => {
  const card = document.querySelector('[data-lifecycle-card="recommendation_hold"]');
  if (!card) return { cardPresent: false };
  const btn = (a) => Array.from(card.querySelectorAll(`[data-skill-action="${a}"]`));
  return {
    cardPresent: true,
    state: card.getAttribute("data-lifecycle-card-state"),
    host: card.getAttribute("data-lifecycle-card-host"),
    confirm: btn("confirm").length, adjust: btn("adjust").length, skip: btn("skip").length,
    pressed: btn("confirm").concat(btn("adjust"), btn("skip"))
      .filter((e) => e.getAttribute("aria-pressed") === "true")
      .map((e) => `${e.getAttribute("data-skill-id")}=${e.getAttribute("data-skill-action")}`),
    text: (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 320),
  };
});
console.log("BEFORE " + JSON.stringify(await readRow()));

for (const entry of PLAN) {
  const [skillId, rest] = entry.split("=");
  const [action, sheetControl] = (rest ?? "").split(":");
  const control = page.locator(`[data-skill-action="${action}"][data-skill-id="${skillId}"]`).first();
  await control.scrollIntoViewIfNeeded().catch(() => {});
  await control.click();
  await page.waitForTimeout(4000);
  if (sheetControl) {
    const sheet = page.locator('[data-slot="sheet-content"], [role="dialog"]').first();
    await sheet.waitFor({ timeout: 60_000 });
    const decide = sheet.getByRole("button", { name: new RegExp(`^${sheetControl}$`, "i") }).first();
    await decide.click();
    await page.waitForTimeout(6000);
    console.log(`  ${skillId}: ${action} — decided in the chip's own sheet with "${sheetControl}"`);
  }
  await page.waitForTimeout(5000);
  console.log(`press ${skillId} = ${action} -> ` + JSON.stringify(await readRow()).slice(0, 260));
}

await page.waitForTimeout(12000);
console.log("SETTLED " + JSON.stringify(await readRow(), null, 1));
const db = new Client({ connectionString: DB });
await db.connect();
const run = (await db.query(
  `select id,status,lifecycle_moment,lifecycle_card_kind,lifecycle_card_ref from cinatra.agent_runs where id=$1`, [process.env.WALK_RUN_ID])).rows[0];
console.log("RUN " + JSON.stringify(run));
const sel = (await db.query(`select count(*) n from cinatra.run_selected_skill_revisions where run_id=$1`, [process.env.WALK_RUN_ID])).rows[0];
console.log("run_selected_skill_revisions for this run: " + sel.n);
await db.end();
await b.close();
