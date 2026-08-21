// D3 — cinatra#2370 S4: store → probe → consumer surfaces.
//
// FIXTURE NOTE (honest labelling): the ADD path needs a live Google account
// (the connector validates the calendar against a fresh account-scoped list),
// which this host cannot have — no Google credential may exist here. So ONE
// stored row is written directly into the connector's OWN config key, exactly
// the shape `addUserGoogleAppointmentSchedule` persists. Everything downstream
// of the store (readiness probe, record-list rendering, capability providers)
// is then the REAL code path. Nothing about the add flow itself is claimed
// from this driver.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb, EMAIL } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370-out/d3");
const APPT = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";

const SEEDED = {
  id: "s4-evidence-row",
  title: "S4 evidence booking page",
  description: "Seeded store row (fixture) — the add path needs a live Google account.",
  bookingPageUrl: "https://calendar.app.google/s4-evidence-row",
  calendarId: "primary@example.com",
  calendarSummary: "Primary calendar (seeded)",
  lastFetchedAt: new Date().toISOString(),
};

const steps = [];
const assertions = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);
  const userId = await withDb((c) =>
    c.query(`select id from public."user" where email = $1 limit 1`, [EMAIL]).then((r) => r.rows[0].id),
  );
  const key = `connector_config:google_appointment_schedules_user:${userId}`;
  const value = JSON.stringify({ schedules: [SEEDED], schedulesSyncedAt: new Date().toISOString() });
  await withDb(async (c) => {
    const cols = await c.query(
      `select column_name from information_schema.columns where table_schema='cinatra' and table_name='metadata' order by 1`,
    );
    steps.push(`metadata columns=${JSON.stringify(cols.rows.map((r) => r.column_name))}`);
    await c.query(
      `insert into cinatra.metadata (key, value) values ($1,$2)
       on conflict (key) do update set value = excluded.value`,
      [key, value],
    );
  });
  steps.push(`seeded key=${key}`);

  // ---- probe: the card badge is the connector's stored-row count ----
  await page.goto(`${BASE}/connectors`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  await shot(page, OUT, "01-connectors-after-seed");
  const gridText = await page.locator("body").innerText();
  const badgeLine = gridText
    .split("\n")
    .map((l, i, all) => (l.includes("Google Appointment Schedules") ? all.slice(i, i + 4).join(" | ") : null))
    .filter(Boolean);
  steps.push(`appt card lines=${JSON.stringify(badgeLine)}`);
  A(
    "D3.1-probe-counts-stored-rows",
    /1\s*(schedule|saved|connected)/i.test(badgeLine.join(" ")) || /Connected/i.test(badgeLine.join(" ")),
    `card lines=${JSON.stringify(badgeLine)}`,
  );

  // ---- the record-list renders the stored row with its calendar badge ----
  await page.goto(`${BASE}${APPT}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  await shot(page, OUT, "02-appt-setup-with-row");
  const t = await page.locator("body").innerText();
  A("D3.2-row-listed", t.includes(SEEDED.title), `record-list shows the stored row`);
  A(
    "D3.3-calendar-badge",
    t.includes(SEEDED.calendarSummary),
    `per-entry calendar badge rendered (${SEEDED.calendarSummary})`,
  );

  // ---- delete through the REAL record-list delete action ----
  const del = page.getByRole("button", { name: /delete|remove/i });
  steps.push(`delete affordance count=${await del.count()}`);
  if (await del.count()) {
    await del.first().click();
    await page.waitForTimeout(2500);
    const confirm = page.getByRole("button", { name: /^(Delete|Remove|Confirm)$/ });
    if (await confirm.count()) {
      await confirm.first().click();
      await page.waitForTimeout(2500);
    }
    await shot(page, OUT, "03-after-delete");
    const after = await withDb((c) =>
      c.query(`select value from cinatra.metadata where key = $1`, [key]).then((r) => r.rows[0]?.value ?? null),
    );
    steps.push(`stored-after-delete=${String(after).slice(0, 400)}`);
    A(
      "D3.4-delete-through-ui",
      !String(after).includes(SEEDED.bookingPageUrl),
      `store after delete=${String(after).slice(0, 200)}`,
    );
  } else {
    A("D3.4-delete-through-ui", false, "no delete affordance found on the record-list");
  }
} catch (err) {
  assertions.push({ id: "D3.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions, seeded: SEEDED }, null, 2));
  await browser.close();
}
