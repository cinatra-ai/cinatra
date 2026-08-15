// C10 — cinatra#2370 S4 CLOSURE item 2b: the disconnected-state guidance
// placeholder on the appointment setup page. The prior run (E6) matched the
// string exactly; this run's D1.11 did not, so capture the whole Calendar field
// group and the live listCalendars payload.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c10");
const APPT = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";
const EXPECTED =
  "No connected calendars yet — connect Google Calendar at /connectors/cinatra-ai/google-calendar-connector/setup to see your calendars here.";

const steps = [];
const assertions = [];
const payloads = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();
page.on("response", async (res) => {
  if (!/\/actions\/(listCalendars|listAppointmentSchedules|bookingPageGuideReady)/.test(res.url())) return;
  try {
    payloads.push({ url: res.url().split("/actions/")[1], status: res.status(), body: (await res.text()).slice(0, 600) });
  } catch {
    /* consumed */
  }
});

try {
  await authenticate(context, steps);
  const res = await page.goto(`${BASE}${APPT}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector('[data-testid="schema-config-form"]', { timeout: 30000 });
  await page.waitForTimeout(4000);
  steps.push(`status=${res?.status()}`);
  await shot(page, OUT, "01-appt-setup-disconnected");

  const formText = (await page.locator('[data-testid="schema-config-form"]').innerText()).replace(/\s+/g, " ");
  steps.push(`form text=${JSON.stringify(formText)}`);
  steps.push(`action payloads=${JSON.stringify(payloads)}`);

  const placeholders = await page
    .locator("input, select, textarea, [data-placeholder]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("placeholder") || e.getAttribute("data-placeholder")).filter(Boolean));
  steps.push(`dom placeholders=${JSON.stringify(placeholders)}`);

  A("C10.1-guidance-string-rendered", formText.includes(EXPECTED), `expected placeholder present=${formText.includes(EXPECTED)}`);
  A("C10.2-calendar-field-label", /Calendar/.test(formText), `Calendar label present`);
  A(
    "C10.3-no-crash",
    !/Application error|Unhandled Runtime Error/.test(formText),
    `no error boundary on the disconnected setup page`,
  );
} catch (err) {
  assertions.push({ id: "C10.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions, payloads }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
