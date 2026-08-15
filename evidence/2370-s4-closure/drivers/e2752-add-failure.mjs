// cinatra#2752 — the schema-config add-failure toast, captured live.
//
// Runs on host2 against the production-equivalent build (next build + next
// start) of the appointment-schedules setup page. Reproduces the #2370 S4
// evidence E10 (non-allowlisted URL) and E11 (404 URL) adds and records what
// the user actually sees: the toast text, its tone, and the server payload the
// action returned.
//
// Usage: S2752_PHASE=before|after node .s2752drivers/e2752-add-failure.mjs
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { authenticate, BASE } from "./lib-auth.mjs";

const PHASE = process.env.S2752_PHASE ?? "before";
const OUT = process.env.S2752_OUT ?? `/Users/ordnas/cinatra-lanes/2752-out/${PHASE}`;
mkdirSync(OUT, { recursive: true });
const APPT = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";

const REPROS = [
  { id: "E10", url: "https://example.com/not-allowed", note: "non-allowlisted URL" },
  { id: "E11", url: "https://calendar.app.google/appt-s4-does-not-exist", note: "404 URL" },
];

const steps = [];
const results = [];
const consoleErrors = [];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});

// Record the action endpoint's raw payload so the toast can be compared with
// what the server actually said.
const payloads = [];
page.on("response", async (res) => {
  if (!res.url().includes("/actions/addSchedule")) return;
  try {
    payloads.push({ status: res.status(), body: (await res.text()).slice(0, 500) });
  } catch {
    /* body already consumed */
  }
});

try {
  await authenticate(context, steps);

  for (const repro of REPROS) {
    await page.goto(`${BASE}${APPT}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="schema-config-form"]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const before = payloads.length;
    await page.fill('input[name="bookingPageUrl"]', repro.url);
    await page.screenshot({ path: `${OUT}/${repro.id}-1-filled.png`, fullPage: false });

    await page.getByRole("button", { name: "Add schedule" }).click();

    let toastText = "(no toast appeared)";
    let toastType = "(none)";
    try {
      const toast = page.locator("[data-sonner-toast]").first();
      await toast.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForTimeout(400);
      toastText = (await toast.innerText()).replace(/\s+/g, " ").trim();
      toastType = (await toast.getAttribute("data-type")) ?? "(no data-type)";
      await page.screenshot({ path: `${OUT}/${repro.id}-2-toast.png`, fullPage: false });
      await toast.screenshot({ path: `${OUT}/${repro.id}-3-toast-crop.png` });
    } catch (e) {
      await page.screenshot({ path: `${OUT}/${repro.id}-2-toast.png`, fullPage: false });
      steps.push(`${repro.id}: toast wait failed: ${e.message}`);
    }

    const listText = (await page.locator('[data-testid="schema-config-form"]').innerText())
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      id: repro.id,
      note: repro.note,
      url: repro.url,
      toastText,
      toastType,
      serverPayload: payloads.slice(before),
      listMentionsEmptyState: /No appointment schedules yet/.test(listText),
    });
    console.log(`${repro.id} toast[${toastType}] = ${toastText}`);

    // let the 8s toast expire so the next repro's capture is unambiguous
    await page.waitForTimeout(9000);
  }
} finally {
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ phase: PHASE, base: BASE, steps, results, consoleErrors }, null, 2),
  );
  await browser.close();
}
console.log("DRIVER-DONE");
