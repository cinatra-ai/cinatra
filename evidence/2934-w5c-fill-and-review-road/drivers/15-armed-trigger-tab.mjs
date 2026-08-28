// W5c picture leg — THE ARMED-TRIGGER TAB, recorded as a named deviation.
//
// The person arms the schedule with the form's OWN control (this driver types the
// form's own rows and presses its own button — no assistant is involved), and the
// armed tab is then photographed with the window's own sentence beneath it. NO
// FILL IS ATTEMPTED on the armed tab: Deviation 1 of the pull request says
// changing an armed schedule from that box is not built in this slice — the armed
// scheduler form belongs to the screens epic — so inventing a fill here would be
// inventing the cell.
//   env: APP_ORIGIN, OWNER_EMAIL, OWNER_PW, SUPABASE_DB_URL, CAPTURE_DIR,
//        SERVER_LOG, LANE_PUBLIC_ORIGIN, RUN_ID, RUN_PATH, WHEN_LOCAL
import { openAs, readFields, readWindow, shoot, stamp, db, runRow, write } from "./03-capture-lib.mjs";

const RUN_ID = process.env.RUN_ID;
const c = await db();
const out = { cell: "armed-trigger", runId: RUN_ID };

const triggers = async () => (await c.query(
  `select trigger_type, scheduled_at, released_at, timezone from cinatra.agent_run_triggers where run_id = $1`, [RUN_ID])).rows;

const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW);
await page.goto(process.env.RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(28_000);

out.before = { run: await runRow(c, RUN_ID), triggers: await triggers(), fields: await readFields(page) };
stamp("before arming", { status: out.before.run?.status, triggers: out.before.triggers.length });

const later = page.getByText("Schedule for later", { exact: false }).first();
if (await later.count()) { await later.click(); await page.waitForTimeout(2000); }
const when = page.locator("#scheduledAt, input[name='scheduledAt']").first();
if (await when.count()) { await when.fill(process.env.WHEN_LOCAL ?? "2026-08-29T09:00"); await page.waitForTimeout(1500); }
const btn = page.getByRole("button", { name: /^(Continue|Save & start run|Start run|Schedule)$/ }).first();
if (await btn.count()) { await btn.click(); stamp("the person pressed the form's own button to arm the schedule"); await page.waitForTimeout(14_000); }

for (let i = 0; i < 20; i += 1) {
  const t = await triggers();
  if (t.length > 0) break;
  await page.waitForTimeout(5000);
}
out.after = { run: await runRow(c, RUN_ID), triggers: await triggers() };
stamp("after arming", { status: out.after.run?.status, triggers: out.after.triggers });

// the armed tab
await page.goto(process.env.RUN_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(26_000);
const tab = page.getByRole("tab", { name: /Schedule/i }).first();
if (await tab.count()) { await tab.click(); await page.waitForTimeout(9000); stamp("the person opened the run's Schedule tab"); }
else {
  const link = page.getByText("Schedule", { exact: true }).first();
  if (await link.count()) { await link.click(); await page.waitForTimeout(9000); stamp("the person opened the run's Schedule step"); }
}
out.armedTab = {
  text: (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(0, 900),
  fields: await readFields(page),
  window: await readWindow(page),
  buttons: await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean)),
};
out.shots = (await shoot(page, "armed-trigger__fill")).map((s) => s.split("/").pop());
out.fillAttempted = false;
write("armed-trigger-readback.json", out);
console.log(JSON.stringify({ status: out.after.run?.status, triggers: out.after.triggers, shots: out.shots }, null, 2));
await c.end();
await browser.close();
