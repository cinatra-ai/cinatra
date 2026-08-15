// D2a — cinatra#2370 S4: archive/uninstall of google-calendar is REFUSED while
// the appointment-schedules dependent is active.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370-out/d2a");
const GCAL_SETTINGS =
  "/configuration/extensions/settings/connector/%40cinatra-ai/google-calendar-connector";
const DEP = "@cinatra-ai/google-appointment-schedules-connector";

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

  const rowsBefore = await withDb((c) =>
    c.query(
      `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1`,
    ).then((r) => r.rows),
  );
  steps.push(`rows-before=${JSON.stringify(rowsBefore)}`);

  const res = await page.goto(`${BASE}${GCAL_SETTINGS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1500);
  steps.push(`gcal settings status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "01-gcal-settings");

  const preview = page.locator('[data-slot="archive-dependents-preview"]');
  const previewCount = await preview.count();
  const previewText = previewCount ? (await preview.first().innerText()).replace(/\s+/g, " ") : "";
  A(
    "D2a.1-dependents-preview-names-dependent",
    previewCount > 0 && previewText.includes(DEP),
    `preview=${JSON.stringify(previewText)}`,
  );
  if (previewCount) {
    await preview.first().scrollIntoViewIfNeeded();
    await shot(page, OUT, "02-dependents-preview");
  }

  const archiveBtn = page.getByRole("button", { name: "Archive", exact: true });
  const hasArchive = (await archiveBtn.count()) > 0;
  steps.push(`archive button count=${await archiveBtn.count()}`);
  if (hasArchive) {
    await archiveBtn.first().click();
    await page.waitForTimeout(4000);
    await shot(page, OUT, "03-archive-refused");
    const err = page.locator('[data-slot="archive-error"]');
    const errText = (await err.count()) ? (await err.first().innerText()).replace(/\s+/g, " ") : "";
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    A(
      "D2a.2-archive-refused-inline",
      (await err.count()) > 0,
      `archive-error=${JSON.stringify(errText)}`,
    );
    A(
      "D2a.3-refusal-names-dependent",
      errText.includes(DEP) || bodyText.includes(`Required by ${DEP}`),
      `errText=${JSON.stringify(errText)}`,
    );
    A(
      "D2a.4-still-on-page-no-crash",
      /google-calendar-connector/.test(page.url()) &&
        !/Application error|Unhandled Runtime Error/.test(bodyText),
      `url=${page.url()}`,
    );
  } else {
    A("D2a.2-archive-refused-inline", false, "no Archive affordance found on the settings page");
  }

  const rowsAfter = await withDb((c) =>
    c.query(
      `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1`,
    ).then((r) => r.rows),
  );
  steps.push(`rows-after=${JSON.stringify(rowsAfter)}`);
  A(
    "D2a.5-calendar-row-still-active",
    rowsAfter.some((r) => r.package_name.endsWith("google-calendar-connector") && r.status === "active"),
    `rows-after=${JSON.stringify(rowsAfter)}`,
  );
} catch (err) {
  assertions.push({ id: "D2a.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
