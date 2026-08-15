// C6 — cinatra#2370 S4 CLOSURE, items 1c/1d/1e: install the REPUBLISHED 0.1.1
// appointment connector through the REAL marketplace inline-install path.
//
// The inline panel (data-testid="extension-install-panel") is rendered page-level
// once opened, so everything after the CTA click is located page-wide.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c6");
const APPT_PKG = "@cinatra-ai/google-appointment-schedules-connector";
const CARD_TITLE = "Google Appointment Schedules";

const steps = [];
const assertions = [];
const toasts = [];
const serverRefs = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}
const rows = () =>
  withDb((c) =>
    c
      .query(
        `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1`,
      )
      .then((r) => r.rows),
  );

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);
  steps.push(`rows-at-start=${JSON.stringify(await rows())}`);

  await page.goto(`${BASE}/configuration/marketplace`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  await shot(page, OUT, "01-marketplace-grid");

  const cardSel = '[data-testid="extension-listing-card"]';
  const idx = await page
    .locator(cardSel)
    .evaluateAll((els, title) => els.findIndex((e) => (e.textContent || "").includes(title)), CARD_TITLE);
  steps.push(`appt card index=${idx}`);
  const card = page.locator(cardSel).nth(idx);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await card.screenshot({ path: `${OUT}/02-appt-card.png` });
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  steps.push(`card text=${JSON.stringify(cardText.slice(0, 400))}`);
  A(
    "C6.1-install-cta-live",
    (await card.locator('[data-testid="extension-install-panel-open"]').count()) > 0,
    `card CTA is a live "Install now" (not an "Installed" badge): ${JSON.stringify(cardText.slice(0, 160))}`,
  );

  await card.locator('[data-testid="extension-install-panel-open"]').first().click();
  await page.waitForTimeout(2500);

  const panel = page.locator('[data-testid="extension-install-panel"]').first();
  await panel.waitFor({ state: "visible", timeout: 20000 });
  await panel.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await panel.screenshot({ path: `${OUT}/03-install-panel.png` }).catch(() => {});
  await shot(page, OUT, "03b-page-with-panel", { fullPage: false });
  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  steps.push(`panel text=${JSON.stringify(panelText.slice(0, 1200))}`);
  A(
    "C6.2-panel-names-required-dependency",
    /google-calendar/i.test(panelText),
    `panel dependency copy: ${JSON.stringify(panelText.slice(0, 500))}`,
  );

  const panelError = page.locator('[data-testid="extension-install-panel-error"]');
  const preErr = (await panelError.count()) ? (await panelError.first().innerText()).replace(/\s+/g, " ") : "";
  steps.push(`panel error before submit=${JSON.stringify(preErr)}`);

  const submit = page.locator('[data-testid="extension-install-panel-submit"]').first();
  const submitCount = await page.locator('[data-testid="extension-install-panel-submit"]').count();
  const disabled = submitCount ? await submit.isDisabled().catch(() => "n/a") : "n/a";
  steps.push(`panel submit count=${submitCount} disabled=${disabled}`);
  A("C6.3-panel-submit-present", submitCount > 0 && disabled !== true, `count=${submitCount} disabled=${disabled}`);

  if (submitCount > 0 && disabled !== true) {
    await submit.click({ timeout: 15000 });
    for (let i = 0; i < 36; i++) {
      await page.waitForTimeout(5000);
      const toastEls = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
      for (const x of toastEls) if (!toasts.includes(x)) toasts.push(x);
      const r = await rows();
      if (r.some((x) => x.package_name === APPT_PKG)) {
        steps.push(`row appeared after ~${(i + 1) * 5}s: ${JSON.stringify(r)}`);
        await shot(page, OUT, "04-install-succeeded", { fullPage: false });
        break;
      }
      if (toastEls.some((x) => /couldn't|could not|fail|unable|error/i.test(x))) {
        steps.push(`failure toast after ~${(i + 1) * 5}s: ${JSON.stringify(toastEls)}`);
        await shot(page, OUT, "04-install-failed", { fullPage: false });
        break;
      }
      const errNow = (await panelError.count())
        ? (await panelError.first().innerText()).replace(/\s+/g, " ")
        : "";
      if (errNow && errNow !== preErr) {
        steps.push(`panel error after ~${(i + 1) * 5}s: ${JSON.stringify(errNow)}`);
        await shot(page, OUT, "04-install-panel-error", { fullPage: false });
        break;
      }
      if (i === 3 || i === 11) await shot(page, OUT, `04-waiting-${i}`, { fullPage: false });
    }
  }
  await shot(page, OUT, "05-after-install");
  steps.push(`toasts=${JSON.stringify(toasts)}`);
  const finalErr = (await panelError.count()) ? (await panelError.first().innerText()).replace(/\s+/g, " ") : "";
  steps.push(`panel error final=${JSON.stringify(finalErr)}`);

  const finalRows = await rows();
  steps.push(`rows-after-install=${JSON.stringify(finalRows)}`);
  const rootRow = finalRows.find((r) => r.package_name === APPT_PKG);
  A("C6.4-root-installed", Boolean(rootRow), `row=${JSON.stringify(rootRow ?? null)}`);
  A(
    "C6.5-root-is-0.1.1",
    rootRow?.version === "0.1.1",
    `installed version=${rootRow?.version ?? "(none)"} — the republished tarball, not the 0.1.0 static bundle`,
  );
  A(
    "C6.6-dependency-auto-satisfied",
    finalRows.some((r) => r.package_name.endsWith("google-calendar-connector") && r.status === "active"),
    `rows=${JSON.stringify(finalRows)}`,
  );

  const batches = await withDb((c) =>
    c
      .query(`select * from cinatra.extension_install_batches order by 1 desc limit 3`)
      .then((r) => r.rows)
      .catch((e) => [{ error: String(e.message) }]),
  );
  steps.push(`install-batches=${JSON.stringify(batches).slice(0, 5000)}`);
  const edges = await withDb((c) =>
    c
      .query(`select * from cinatra.extension_dependency_edge limit 30`)
      .then((r) => r.rows)
      .catch((e) => [{ error: String(e.message) }]),
  );
  steps.push(`dependency-edges=${JSON.stringify(edges).slice(0, 4000)}`);

  const setupRes = await page.goto(`${BASE}/connectors/cinatra-ai/google-appointment-schedules-connector/setup`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(3000);
  await shot(page, OUT, "06-setup-after-marketplace-install");
  const setupText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  A(
    "C6.7-setup-renders-after-install",
    setupRes?.status() === 200 && /Booking page URL/i.test(setupText),
    `status=${setupRes?.status()} hasField=${/Booking page URL/i.test(setupText)}`,
  );
  void serverRefs;
} catch (err) {
  assertions.push({ id: "C6.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions, toasts }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
