// C1 — cinatra#2370 S4 CLOSURE: the marketplace surfaces for the republished
// 0.1.1 appointment connector, and the google-calendar listing half of item 5.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "/Users/ordnas/cinatra-lanes/2370c-out/c1");
const APPT_DETAIL = "/configuration/marketplace/cinatra-ai/google-appointment-schedules-connector";
const GCAL_DETAIL = "/configuration/marketplace/cinatra-ai/google-calendar-connector";

const steps = [];
const assertions = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);

  // ---- grid
  let res = await page.goto(`${BASE}/configuration/marketplace`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  steps.push(`grid status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "01-marketplace-grid");
  const gridText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  A("C1.1-appt-card-listed", gridText.includes("Google Appointment Schedules"), "card title on the live storefront grid");

  // ---- appointment detail
  res = await page.goto(`${BASE}${APPT_DETAIL}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  steps.push(`appt detail status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "02-appt-detail");
  const apptText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  steps.push(`appt detail text=${JSON.stringify(apptText.slice(0, 1500))}`);
  A("C1.2-appt-detail-version-0.1.1", /0\.1\.1/.test(apptText), `version token 0.1.1 present=${/0\.1\.1/.test(apptText)}`);
  A(
    "C1.3-appt-detail-declares-required-dependency",
    /google-calendar-connector/.test(apptText),
    `dependency named on the detail page`,
  );

  // ---- google-calendar detail (item 5 storefront half)
  res = await page.goto(`${BASE}${GCAL_DETAIL}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  steps.push(`gcal detail status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "03-gcal-detail");
  const gcalText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const traces = [...gcalText.matchAll(/[^.]*appointment[^.]*\./gi)].map((m) => m[0].trim().slice(0, 220));
  steps.push(`gcal traces=${JSON.stringify(traces.slice(0, 6))}`);
  A(
    "C1.4-gcal-storefront-listing-clean",
    traces.length === 0,
    `appointment traces on the google-calendar marketplace detail page: ${JSON.stringify(traces.slice(0, 4))}`,
  );
} catch (err) {
  assertions.push({ id: "C1.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
