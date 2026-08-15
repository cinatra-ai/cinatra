// C11 — the runtime 0.1.1 install shadows the 0.1.0 static bundle but cannot be
// imported in-process on this lane ("no trusted install record"), so every UI
// action 404s. Record that state, then archive the org-scoped 0.1.1 row through
// the product's own lifecycle control and confirm the bundle serves again.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c11");
const APPT_SETTINGS =
  "/configuration/extensions/settings/connector/%40cinatra-ai/google-appointment-schedules-connector";
const APPT_SETUP = "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";

const steps = [];
const assertions = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}
const rows = () =>
  withDb((c) =>
    c
      .query(
        `select package_name, version, status from cinatra.installed_extension where package_name ilike '%appointment%' order by version`,
      )
      .then((r) => r.rows),
  );

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);
  steps.push(`rows-before=${JSON.stringify(await rows())}`);

  const res = await page.goto(`${BASE}${APPT_SETTINGS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  steps.push(`settings status=${res?.status()}`);
  await shot(page, OUT, "01-appt-settings");
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  steps.push(`settings text=${JSON.stringify(text.slice(0, 2000))}`);
  const controls = await page.locator("button").evaluateAll((els) =>
    els
      .map((e) => ({
        text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        disabled: e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true",
        title: e.getAttribute("title"),
      }))
      .filter((b) => /archive|activate|reinstall|force-delete|update/i.test(b.text)),
  );
  steps.push(`controls=${JSON.stringify(controls)}`);

  const archive = page.getByRole("button", { name: "Archive", exact: true });
  const disabled = (await archive.count()) ? await archive.first().isDisabled() : null;
  A(
    "C11.1-runtime-install-has-live-lifecycle-controls",
    (await archive.count()) > 0 && disabled === false,
    `Archive present=${(await archive.count()) > 0} disabled=${disabled} (org-scoped runtime install, unlike the platform bundle)`,
  );

  if ((await archive.count()) > 0 && disabled === false) {
    await archive.first().click({ timeout: 15000 });
    await page.waitForTimeout(8000);
    await shot(page, OUT, "02-after-archive");
    steps.push(`toasts=${JSON.stringify(await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []))}`);
    steps.push(`rows-after-archive=${JSON.stringify(await rows())}`);
  }

  await page.goto(`${BASE}${APPT_SETUP}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector('[data-testid="schema-config-form"]', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, OUT, "03-setup-after-archive");
  const formText = (await page.locator('[data-testid="schema-config-form"]').innerText().catch(() => "(no form)")).replace(
    /\s+/g,
    " ",
  );
  steps.push(`setup form text=${JSON.stringify(formText.slice(0, 1500))}`);
  A(
    "C11.2-actions-served-again",
    !/No registered UI action/.test(formText),
    `setup page action state: ${/No registered UI action/.test(formText) ? "still 404" : "actions served"}`,
  );
} catch (err) {
  assertions.push({ id: "C11.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
