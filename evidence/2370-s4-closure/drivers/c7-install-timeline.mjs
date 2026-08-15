// C7 — cinatra#2370 S4 CLOSURE: the real marketplace install of 0.1.1, with the
// installed_extension ledger sampled every 2 s so the row's whole lifetime
// (appear → activate-or-vanish) is on the record, not just its end state.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c7");
const CARD_TITLE = "Google Appointment Schedules";
const steps = [];
const timeline = [];
const toasts = [];

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
  const t0 = Date.now();
  const sample = async (note) => {
    const r = await rows();
    timeline.push({ tMs: Date.now() - t0, note, rows: r });
  };
  await sample("before-navigate");

  await page.goto(`${BASE}/configuration/marketplace`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  await sample("marketplace-loaded");

  const cardSel = '[data-testid="extension-listing-card"]';
  const idx = await page
    .locator(cardSel)
    .evaluateAll((els, title) => els.findIndex((e) => (e.textContent || "").includes(title)), CARD_TITLE);
  const card = page.locator(cardSel).nth(idx);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await card.screenshot({ path: `${OUT}/01-card.png` });
  await card.locator('[data-testid="extension-install-panel-open"]').first().click();
  await page.waitForTimeout(2000);
  const panel = page.locator('[data-testid="extension-install-panel"]').first();
  await panel.waitFor({ state: "visible", timeout: 20000 });
  await panel.screenshot({ path: `${OUT}/02-panel.png` }).catch(() => {});
  steps.push(`panel text=${JSON.stringify((await panel.innerText()).replace(/\s+/g, " "))}`);
  await sample("panel-open");

  await page.locator('[data-testid="extension-install-panel-submit"]').first().click({ timeout: 15000 });
  steps.push("submit clicked");

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    await sample(`t+${(i + 1) * 2}s`);
    const toastEls = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    for (const x of toastEls) if (!toasts.includes(x)) toasts.push(x);
    if (i === 2) await shot(page, OUT, "03-shortly-after-submit", { fullPage: false });
  }
  await shot(page, OUT, "04-final", { fullPage: false });
  steps.push(`toasts=${JSON.stringify(toasts)}`);
  const panelErr = page.locator('[data-testid="extension-install-panel-error"]');
  steps.push(
    `panel error final=${JSON.stringify(
      (await panelErr.count()) ? (await panelErr.first().innerText()).replace(/\s+/g, " ") : "",
    )}`,
  );
} catch (err) {
  steps.push(`FATAL ${String(err && err.stack ? err.stack : err)}`);
  console.error(err);
} finally {
  writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ base: BASE, steps, toasts, timeline }, null, 2));
  await browser.close();
}
const compact = timeline.map((s) => `${s.tMs}ms ${s.note} :: ${s.rows.map((r) => `${r.version}/${r.status}`).join(",") || "(none)"}`);
console.log(compact.join("\n"));
console.log("DRIVER-DONE");
