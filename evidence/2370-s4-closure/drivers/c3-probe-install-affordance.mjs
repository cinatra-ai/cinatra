// C3 — probe: where does the install affordance live for the appointment
// connector, on the grid and on the detail page?
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "/Users/ordnas/cinatra-lanes/2370c-out/c3");
const steps = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
const page = await context.newPage();
await authenticate(context, steps);

const report = {};
for (const [key, url] of [
  ["grid", "/configuration/marketplace"],
  ["detail", "/configuration/marketplace/cinatra-ai/google-appointment-schedules-connector"],
]) {
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/${key}.png`, fullPage: true });
  const buttons = await page.locator("button, a[role=button]").evaluateAll((els) =>
    els.map((e) => ({
      text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      testid: e.getAttribute("data-testid"),
      disabled: e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true",
    })).filter((b) => b.text || b.testid),
  );
  const testids = await page.locator("[data-testid]").evaluateAll((els) =>
    [...new Set(els.map((e) => e.getAttribute("data-testid")))],
  );
  report[key] = { url: page.url(), buttons, testids };
}
writeFileSync(`${OUT}/probe.json`, JSON.stringify({ steps, report }, null, 2));
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
await browser.close();
console.log("DRIVER-DONE");
