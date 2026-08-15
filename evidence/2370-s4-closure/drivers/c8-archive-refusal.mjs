// C8 — cinatra#2370 S4 CLOSURE item 1e: is uninstall/archive of
// google-calendar REFUSED while the appointment dependent is active?
//
// The Archive control exists but may be disabled; a disabled control IS the
// refusal, so this driver records its enabled state, its title/aria text, the
// dependents preview, and any adjacent explanation, then attempts the click
// only when the control is enabled.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c8");
const GCAL_SETTINGS = "/configuration/extensions/settings/connector/%40cinatra-ai/google-calendar-connector";
const DEP = "@cinatra-ai/google-appointment-schedules-connector";

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
  const rowsBefore = await withDb((c) =>
    c
      .query(
        `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1,2`,
      )
      .then((r) => r.rows),
  );
  steps.push(`rows-before=${JSON.stringify(rowsBefore)}`);

  const res = await page.goto(`${BASE}${GCAL_SETTINGS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  steps.push(`status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "01-gcal-settings");
  const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  steps.push(`page text=${JSON.stringify(bodyText.slice(0, 2500))}`);

  const controls = await page.locator("button").evaluateAll((els) =>
    els
      .map((e) => ({
        text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        disabled: e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true",
        title: e.getAttribute("title"),
        ariaLabel: e.getAttribute("aria-label"),
        describedBy: e.getAttribute("aria-describedby"),
      }))
      .filter((b) => /archive|uninstall|remove|delete|restore/i.test(b.text)),
  );
  steps.push(`lifecycle controls=${JSON.stringify(controls)}`);

  const preview = page.locator('[data-slot="archive-dependents-preview"]');
  const previewText = (await preview.count()) ? (await preview.first().innerText()).replace(/\s+/g, " ") : "";
  steps.push(`dependents preview=${JSON.stringify(previewText)}`);
  A(
    "C8.1-dependents-preview-names-dependent",
    previewText.includes(DEP),
    `preview=${JSON.stringify(previewText.slice(0, 400))}`,
  );

  const archive = page.getByRole("button", { name: "Archive", exact: true });
  const archiveCount = await archive.count();
  const archiveDisabled = archiveCount ? await archive.first().isDisabled() : null;
  steps.push(`archive count=${archiveCount} disabled=${archiveDisabled}`);
  if (archiveCount) {
    await archive.first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, OUT, "02-archive-control");
    await archive.first().hover().catch(() => {});
    await page.waitForTimeout(1200);
    await shot(page, OUT, "03-archive-hover");
    const tips = await page.locator('[role="tooltip"]').allInnerTexts().catch(() => []);
    steps.push(`tooltips=${JSON.stringify(tips)}`);
  }
  A(
    "C8.2-archive-refused-while-dependent-active",
    archiveCount > 0 && archiveDisabled === true,
    `Archive control present=${archiveCount > 0}, disabled(refused)=${archiveDisabled}`,
  );

  if (archiveCount && archiveDisabled === false) {
    await archive.first().click({ timeout: 10000 }).catch((e) => steps.push(`archive click: ${e.message}`));
    await page.waitForTimeout(4000);
    await shot(page, OUT, "04-after-archive-click");
    const err = page.locator('[data-slot="archive-error"]');
    const errText = (await err.count()) ? (await err.first().innerText()).replace(/\s+/g, " ") : "";
    steps.push(`archive-error=${JSON.stringify(errText)}`);
    A("C8.3-refusal-names-dependent", errText.includes(DEP), `errText=${JSON.stringify(errText)}`);
  }

  const rowsAfter = await withDb((c) =>
    c
      .query(
        `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1,2`,
      )
      .then((r) => r.rows),
  );
  steps.push(`rows-after=${JSON.stringify(rowsAfter)}`);
  A(
    "C8.4-calendar-still-active",
    rowsAfter.some((r) => r.package_name.endsWith("google-calendar-connector") && r.status === "active"),
    `rows-after=${JSON.stringify(rowsAfter)}`,
  );
} catch (err) {
  assertions.push({ id: "C8.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
