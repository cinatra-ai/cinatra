// C4 — cinatra#2370 S4 CLOSURE, items 1c/1d/1e: install the REPUBLISHED 0.1.1
// appointment connector through the REAL marketplace inline-install path.
//
// Card affordances (probed live on this build): the grid card carries
// data-testid="extension-listing-card"; its CTA is "extension-card-cta" /
// "extension-install-panel-open"; the panel submit is "extension-card-cta-submit".
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "/Users/ordnas/cinatra-lanes/2370c-out/c4");
const APPT_PKG = "@cinatra-ai/google-appointment-schedules-connector";
const CARD_TITLE = "Google Appointment Schedules";

const steps = [];
const assertions = [];
const toasts = [];
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
  await page.waitForTimeout(3500);
  await shot(page, OUT, "01-marketplace-grid");

  const card = page
    .locator('[data-testid="extension-listing-card"]')
    .filter({ hasText: CARD_TITLE })
    .first();
  const cardCount = await card.count();
  steps.push(`card count=${cardCount}`);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  await card.screenshot({ path: `${OUT}/02-appt-card.png` }).catch(() => {});
  const cardText = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
  steps.push(`card text=${JSON.stringify(cardText.slice(0, 500))}`);

  const openBtn = card.locator('[data-testid="extension-install-panel-open"]');
  const openCount = await openBtn.count();
  const installedBadge = /(^|\s)Installed(\s|$)/.test(cardText);
  A(
    "C4.1-install-cta-live",
    openCount > 0,
    `install-panel-open=${openCount} installedBadge=${installedBadge} cardText=${JSON.stringify(cardText.slice(0, 200))}`,
  );

  if (openCount > 0) {
    await openBtn.first().click();
    await page.waitForTimeout(1500);
    await shot(page, OUT, "03-install-panel");
    await card.screenshot({ path: `${OUT}/03b-install-panel-card.png` }).catch(() => {});
    const panelText = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
    steps.push(`panel text=${JSON.stringify(panelText.slice(0, 900))}`);
    A(
      "C4.2-panel-declares-dependency",
      /google-calendar-connector/i.test(panelText),
      `panel names the required dependency: ${JSON.stringify(panelText.slice(0, 400))}`,
    );

    const submit = card.locator('[data-testid="extension-card-cta-submit"]');
    steps.push(`submit count=${await submit.count()}`);
    if (await submit.count()) {
      await shot(page, OUT, "04-before-submit");
      await submit.first().click({ timeout: 15000 });
    } else {
      A("C4.SUBMIT-MISSING", false, "no extension-card-cta-submit inside the opened panel");
    }

    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(5000);
      const toastEls = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
      for (const x of toastEls) if (!toasts.includes(x)) toasts.push(x);
      const r = await rows();
      if (r.some((x) => x.package_name === APPT_PKG)) {
        steps.push(`row appeared after ~${(i + 1) * 5}s: ${JSON.stringify(r)}`);
        break;
      }
      if (toastEls.some((x) => /couldn't|could not|fail|unable|error/i.test(x))) {
        steps.push(`failure toast after ~${(i + 1) * 5}s: ${JSON.stringify(toastEls)}`);
        break;
      }
      if (i === 3 || i === 9) await shot(page, OUT, `05-waiting-${i}`);
    }
    await shot(page, OUT, "06-after-install");
    steps.push(`toasts=${JSON.stringify(toasts)}`);
  }

  const finalRows = await rows();
  steps.push(`rows-after-install=${JSON.stringify(finalRows)}`);
  const rootRow = finalRows.find((r) => r.package_name === APPT_PKG);
  A("C4.3-root-installed", Boolean(rootRow), `row=${JSON.stringify(rootRow ?? null)}`);
  A(
    "C4.4-root-is-0.1.1",
    rootRow?.version === "0.1.1",
    `installed version=${rootRow?.version ?? "(none)"} (the republished tarball, not the 0.1.0 static bundle)`,
  );
  A(
    "C4.5-dependency-satisfied-active",
    finalRows.some((r) => r.package_name.endsWith("google-calendar-connector") && r.status === "active"),
    `rows=${JSON.stringify(finalRows)}`,
  );

  const batches = await withDb((c) =>
    c
      .query(`select * from cinatra.extension_install_batches order by 1 desc limit 3`)
      .then((r) => r.rows)
      .catch((e) => [{ error: String(e.message) }]),
  );
  steps.push(`install-batches=${JSON.stringify(batches).slice(0, 4000)}`);
  const edges = await withDb((c) =>
    c
      .query(`select * from cinatra.extension_dependency_edge limit 20`)
      .then((r) => r.rows)
      .catch((e) => [{ error: String(e.message) }]),
  );
  steps.push(`dependency-edges=${JSON.stringify(edges).slice(0, 3000)}`);

  const setupRes = await page.goto(`${BASE}/connectors/cinatra-ai/google-appointment-schedules-connector/setup`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(3000);
  await shot(page, OUT, "07-setup-after-marketplace-install");
  const setupText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  A(
    "C4.6-setup-renders-after-install",
    setupRes?.status() === 200 && /Booking page URL/i.test(setupText),
    `status=${setupRes?.status()}`,
  );
} catch (err) {
  assertions.push({ id: "C4.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions, toasts }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
