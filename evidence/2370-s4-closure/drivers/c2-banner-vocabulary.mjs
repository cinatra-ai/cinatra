// C2 — cinatra#2370 S4 CLOSURE: the schema-config shell's banner handling now
// that the connector DECLARES its banner vocabulary (saved/deleted/error).
//
// The real success path needs a reachable calendar.app.google page and a
// connected Google account, neither of which exists on this host, so the
// handler's ANSWER is canned at the network boundary — exactly the technique
// the #2752 lane used. The page, the build, the shell and the declared schema
// are the real ones; only the action response body is substituted.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c2");
const APPT = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";

const CASES = [
  {
    id: "C2-1-saved",
    body: { result: { banner: "saved" } },
    expectType: "success",
    expectText: "Appointment schedule added.",
    note: "declared success variant",
  },
  {
    id: "C2-2-deleted",
    body: { result: { banner: "deleted" } },
    expectType: "success",
    expectText: "Appointment schedule removed.",
    note: "declared success variant (second)",
  },
  {
    id: "C2-3-error-with-message",
    body: {
      result: {
        banner: "error",
        message:
          '"not-real" is not one of your Google calendars. Connect Google Calendar and try again, or omit calendarId to use your primary calendar.',
      },
    },
    expectType: "error",
    expectText: "is not one of your Google calendars",
    note: "the invalid-calendarId refusal the connector returns (item 3c wording)",
  },
  {
    id: "C2-4-error-no-message",
    body: { result: { banner: "error" } },
    expectType: "error",
    expectText: "Couldn't add the appointment schedule.",
    note: "declared destructive variant fallback",
  },
];

const steps = [];
const results = [];
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

  for (const c of CASES) {
    await page.unrouteAll();
    await page.route("**/actions/addSchedule", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(c.body) });
    });
    await page.goto(`${BASE}${APPT}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector('[data-testid="schema-config-form"]', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.fill('input[name="bookingPageUrl"]', "https://calendar.app.google/closure-canned");
    await page.getByRole("button", { name: "Add schedule" }).click();

    let toastText = "(no toast appeared)";
    let toastType = "(none)";
    try {
      const toast = page.locator("[data-sonner-toast]").first();
      await toast.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForTimeout(400);
      toastText = (await toast.innerText()).replace(/\s+/g, " ").trim();
      toastType = (await toast.getAttribute("data-type")) ?? "(no data-type)";
      await page.screenshot({ path: `${OUT}/${c.id}-toast.png`, fullPage: false });
      await toast.screenshot({ path: `${OUT}/${c.id}-toast-crop.png` });
    } catch (e) {
      await page.screenshot({ path: `${OUT}/${c.id}-toast.png`, fullPage: false });
      steps.push(`${c.id}: toast wait failed: ${e.message}`);
    }

    results.push({ ...c, toastText, toastType });
    A(
      `${c.id}-tone`,
      toastType === c.expectType,
      `expected tone=${c.expectType} actual=${toastType} (${c.note})`,
    );
    A(
      `${c.id}-text`,
      toastText.includes(c.expectText),
      `expected text to contain ${JSON.stringify(c.expectText)}; actual=${JSON.stringify(toastText)}`,
    );
    await page.waitForTimeout(9000);
  }
} catch (err) {
  assertions.push({ id: "C2.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, steps, results, assertions }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
