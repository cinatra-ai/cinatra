// D1 — cinatra#2370 S4: connector grid + both setup surfaces.
// Covers: extraction-clean (calendar setup = Setup/Help only, zero appointment
// traces, card Connected = Nango state), the appointment connector's setup page
// (record-list / booking URL / calendar select with the EXACT disconnected
// guidance placeholder), the prose verbatim, Help last.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "/Users/ordnas/cinatra-lanes/2370-out/d1");
const APPT = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";
const GCAL = "/connectors/cinatra-ai/google-calendar-connector/setup";

const EXPECTED_PLACEHOLDER =
  "No connected calendars yet — connect Google Calendar at /connectors/cinatra-ai/google-calendar-connector/setup to see your calendars here.";
const EXPECTED_PROSE =
  "A public Google Calendar appointment-schedule link (calendar.app.google/…) the assistant shares so people can book time with you — a share link, not a calendar sync. Get one in Google Calendar: Create → Appointment schedule, then paste its public link here.";

const steps = [];
const assertions = [];
const consoleErrors = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});

try {
  await authenticate(context, steps);

  // ---------------- /connectors grid ----------------
  await page.goto(`${BASE}/connectors`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1500);
  steps.push(`connectors url=${page.url()}`);
  await shot(page, OUT, "01-connectors-grid");

  const gridText = await page.locator("body").innerText();
  A("D1.1-appt-card-present", /Google Appointment Schedules/.test(gridText), "grid text contains the new card title");
  A("D1.2-gcal-card-present", /Google Calendar/.test(gridText), "grid text contains the calendar card title");
  A(
    "D1.3-no-appt-count-label",
    !/\d+\s*appt/i.test(gridText),
    `page-wide /\\d+\\s*appt/i match=${/\d+\s*appt/i.test(gridText)}`,
  );

  const cardOf = async (title) => {
    const h = page.getByText(title, { exact: true }).first();
    const card = h.locator("xpath=ancestor::*[self::a or self::div][1]/ancestor-or-self::*[3]");
    return card;
  };
  try {
    const apptCard = await cardOf("Google Appointment Schedules");
    await apptCard.screenshot({ path: `${OUT}/02-appt-card.png` });
    const t = await apptCard.innerText();
    A("D1.4-appt-card-badge", /Not connected/i.test(t), `appt card text=${JSON.stringify(t.slice(0, 200))}`);
  } catch (e) {
    A("D1.4-appt-card-badge", false, `card crop failed: ${e.message}`);
  }
  try {
    const gcalCard = await cardOf("Google Calendar");
    await gcalCard.screenshot({ path: `${OUT}/03-gcal-card.png` });
    const t = await gcalCard.innerText();
    A(
      "D1.5-gcal-card-nango-state",
      /Not connected/i.test(t) && !/appt|appointment/i.test(t),
      `gcal card text=${JSON.stringify(t.slice(0, 200))} (no Nango google connection exists on this host ⇒ Not connected)`,
    );
  } catch (e) {
    A("D1.5-gcal-card-nango-state", false, `card crop failed: ${e.message}`);
  }

  // ---------------- appointment connector setup ----------------
  const apptRes = await page.goto(`${BASE}${APPT}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);
  steps.push(`appt setup status=${apptRes?.status()} url=${page.url()}`);
  await shot(page, OUT, "04-appt-setup-setup-tab");

  const tabs = await page.getByRole("tab").allInnerTexts();
  steps.push(`appt tabs=${JSON.stringify(tabs)}`);
  A("D1.6-appt-help-last", tabs.length > 0 && tabs[tabs.length - 1].trim() === "Help", `tabs=${JSON.stringify(tabs)}`);

  const apptText = await page.locator("body").innerText();
  A(
    "D1.7-record-list-empty-state",
    apptText.includes("No appointment schedules yet. Paste a booking page link below to add one."),
    "declared record-list emptyState rendered",
  );
  A("D1.8-booking-url-field", /Booking page URL/.test(apptText), "text field label present");
  A("D1.9-calendar-field", /\bCalendar\b/.test(apptText), "dynamic-select-options label present");
  A("D1.10-add-schedule-action", /Add schedule/.test(apptText), "named-action button present");

  // The disconnected-state placeholder — read from the rendered control.
  const placeholders = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("input,select,textarea,[data-placeholder],[aria-label]")) {
      const p = el.getAttribute("placeholder") ?? el.getAttribute("data-placeholder");
      if (p) out.push(p);
    }
    for (const el of document.querySelectorAll("button,span,div,p")) {
      const t = (el.textContent ?? "").trim();
      if (t.startsWith("No connected calendars yet")) out.push(t);
    }
    return [...new Set(out)];
  });
  steps.push(`placeholders=${JSON.stringify(placeholders)}`);
  const placeholderHit = placeholders.some((p) => p.replace(/\s+/g, " ").trim() === EXPECTED_PLACEHOLDER);
  A(
    "D1.11-disconnected-guidance-placeholder-exact",
    placeholderHit || apptText.replace(/\s+/g, " ").includes(EXPECTED_PLACEHOLDER),
    `expected=${JSON.stringify(EXPECTED_PLACEHOLDER)} seen=${JSON.stringify(placeholders)}`,
  );

  // options must be EMPTY (no live Google connection) and no crash
  A(
    "D1.12-no-crash-disconnected",
    !/Application error|Unhandled Runtime Error|This page could not be found/.test(apptText),
    "no error boundary on the disconnected setup page",
  );

  // Help tab — the verbatim prose
  const helpTab = page.getByRole("tab", { name: "Help" });
  if (await helpTab.count()) {
    await helpTab.first().click();
    await page.waitForTimeout(800);
    await shot(page, OUT, "05-appt-setup-help-tab");
    const helpText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    A(
      "D1.13-prose-verbatim",
      helpText.includes(EXPECTED_PROSE.replace(/\s+/g, " ")),
      `verbatim prose present=${helpText.includes(EXPECTED_PROSE.replace(/\s+/g, " "))}`,
    );
  } else {
    A("D1.13-prose-verbatim", false, "no Help tab found");
  }

  // ---------------- google-calendar setup (extraction clean) ----------------
  const gcalRes = await page.goto(`${BASE}${GCAL}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);
  steps.push(`gcal setup status=${gcalRes?.status()} url=${page.url()}`);
  await shot(page, OUT, "06-gcal-setup");
  const gcalTabs = await page.getByRole("tab").allInnerTexts();
  steps.push(`gcal tabs=${JSON.stringify(gcalTabs)}`);
  A(
    "D1.14-gcal-tabs-setup-help-only",
    JSON.stringify(gcalTabs.map((t) => t.trim())) === JSON.stringify(["Setup", "Help"]),
    `tabs=${JSON.stringify(gcalTabs)}`,
  );
  const gcalText = await page.locator("body").innerText();
  const traces = ["appointment", "booking", "calendar.app.google", "schedule"].filter((w) =>
    new RegExp(w.replace(".", "\\."), "i").test(gcalText),
  );
  A("D1.15-gcal-zero-appointment-traces", traces.length === 0, `traces=${JSON.stringify(traces)}`);

  // Help tab of the calendar connector too
  const gcalHelp = page.getByRole("tab", { name: "Help" });
  if (await gcalHelp.count()) {
    await gcalHelp.first().click();
    await page.waitForTimeout(700);
    await shot(page, OUT, "07-gcal-setup-help");
    const t = (await page.locator("body").innerText()).toLowerCase();
    const helpTraces = ["appointment", "booking", "calendar.app.google"].filter((w) => t.includes(w));
    A("D1.16-gcal-help-zero-traces", helpTraces.length === 0, `helpTraces=${JSON.stringify(helpTraces)}`);
  }
  steps.push(`gcalText=${JSON.stringify(gcalText.slice(0, 1200))}`);
} catch (err) {
  assertions.push({ id: "D1.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(
    `${OUT}/assertions.json`,
    JSON.stringify({ base: BASE, steps, assertions, consoleErrors }, null, 2),
  );
  await browser.close();
}
