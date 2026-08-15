// D2b — cinatra#2370 S4: remove the appointment connector, then install it
// again through the REAL marketplace install path and observe the required
// google-calendar dependency being auto-satisfied on an image that bundles it.
//
// Stages are selectable so a failure mid-way keeps the earlier evidence:
//   node d2b-marketplace-install.mjs remove
//   node d2b-marketplace-install.mjs install
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE, withDb } from "./lib-auth.mjs";

const STAGE = process.argv[2] ?? "install";
const OUT = ensureDir(process.env.S4_OUT ?? `<lane-out>/2370-out/d2b-${STAGE}`);
const APPT_PKG = "@cinatra-ai/google-appointment-schedules-connector";
const APPT_SETTINGS =
  "/configuration/extensions/settings/connector/%40cinatra-ai/google-appointment-schedules-connector";
const CARD_TITLE = "Google Appointment Schedules";

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
        `select package_name, version, status from cinatra.installed_extension where package_name ilike '%google%' order by 1`,
      )
      .then((r) => r.rows),
  );

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const toasts = [];
page.on("console", () => {});

try {
  await authenticate(context, steps);
  steps.push(`rows-at-start=${JSON.stringify(await rows())}`);

  if (STAGE === "remove") {
    // Hard-remove the dependent so the marketplace CTA becomes a real INSTALL
    // (an archived row would offer Restore, which is a different path).
    const res = await page.goto(`${BASE}${APPT_SETTINGS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    steps.push(`appt settings status=${res?.status()}`);
    await page.waitForTimeout(1200);
    await shot(page, OUT, "01-appt-settings");
    const fd = page.getByRole("button", { name: /Force-delete…/ });
    if (!(await fd.count())) throw new Error("no Force-delete affordance");
    await fd.first().click();
    await page.waitForTimeout(600);
    await page.locator("#force-delete-reason").fill("cinatra#2370 S4 — re-install through the real marketplace path");
    await shot(page, OUT, "02-force-delete-dialog");
    await page.getByRole("button", { name: "Force-delete", exact: true }).click();
    await page.waitForTimeout(6000);
    await shot(page, OUT, "03-after-force-delete");
    const after = await rows();
    steps.push(`rows-after-remove=${JSON.stringify(after)}`);
    A(
      "D2b.0-dependent-removed",
      !after.some((r) => r.package_name === APPT_PKG),
      `rows=${JSON.stringify(after)}`,
    );
  } else {
    // ---------------- the REAL marketplace install ----------------
    page.on("console", () => {});
    const res = await page.goto(`${BASE}/configuration/marketplace`, { waitUntil: "domcontentloaded", timeout: 90000 });
    steps.push(`marketplace status=${res?.status()} url=${page.url()}`);
    await page.waitForTimeout(2500);
    await shot(page, OUT, "01-marketplace");

    const bodyText = await page.locator("body").innerText();
    A("D2b.1-card-listed", bodyText.includes(CARD_TITLE), `card "${CARD_TITLE}" listed from the live storefront catalog`);
    const registryBannerPresent = /Installing requires the package registry|registry connected/i.test(bodyText);
    steps.push(`registry banner text seen=${registryBannerPresent}`);

    // Locate the card and its CTA.
    const card = page
      .locator("div", { hasText: new RegExp(CARD_TITLE) })
      .filter({ has: page.getByText(CARD_TITLE, { exact: true }) })
      .last();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await card.screenshot({ path: `${OUT}/02-appt-card.png` }).catch(() => {});

    const openBtn = card.locator('[data-testid="extension-install-panel-open"]');
    const plainInstall = card.getByRole("button", { name: /Install now/ });
    const ctaText = await card.innerText().catch(() => "");
    steps.push(`card text=${JSON.stringify(ctaText.slice(0, 400))}`);
    A(
      "D2b.2-install-cta-live",
      (await openBtn.count()) > 0 || (await plainInstall.count()) > 0,
      `panel-open=${await openBtn.count()} plain-install=${await plainInstall.count()}`,
    );

    if (await openBtn.count()) {
      await openBtn.first().click();
      await page.waitForTimeout(1200);
      await shot(page, OUT, "03-install-panel");
      const submit = card.locator('[data-testid="extension-install-panel-submit"]');
      if (!(await submit.count())) {
        // picker may need a selection first
        const picker = card.locator('[data-testid="extension-install-panel-picker"] button').first();
        if (await picker.count()) {
          await picker.click();
          await page.waitForTimeout(700);
          await shot(page, OUT, "04-install-picker");
          await page.keyboard.press("Enter");
          await page.waitForTimeout(700);
        }
      }
      const submit2 = card.locator('[data-testid="extension-install-panel-submit"]');
      steps.push(`submit count=${await submit2.count()} disabled=${await submit2.first().isDisabled().catch(() => "n/a")}`);
      await shot(page, OUT, "05-before-submit");
      if (await submit2.count()) {
        await submit2.first().click({ timeout: 10000 });
      }
    } else if (await plainInstall.count()) {
      await plainInstall.first().click();
    }

    // Watch the install through: batch sagas take a while.
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(5000);
      const t = await page.locator("body").innerText();
      const toastEls = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
      for (const x of toastEls) if (!toasts.includes(x)) toasts.push(x);
      const r = await rows();
      if (r.some((x) => x.package_name === APPT_PKG)) {
        steps.push(`row appeared after ~${(i + 1) * 5}s: ${JSON.stringify(r)}`);
        break;
      }
      if (toastEls.some((x) => /fail|could not|unable|error/i.test(x))) {
        steps.push(`failure toast after ~${(i + 1) * 5}s: ${JSON.stringify(toastEls)}`);
        break;
      }
      if (i === 5 || i === 11) await shot(page, OUT, `06-waiting-${i}`);
      void t;
    }
    await shot(page, OUT, "07-after-install");
    steps.push(`toasts=${JSON.stringify(toasts)}`);

    const finalRows = await rows();
    steps.push(`rows-after-install=${JSON.stringify(finalRows)}`);
    A(
      "D2b.3-root-installed",
      finalRows.some((r) => r.package_name === APPT_PKG),
      `rows=${JSON.stringify(finalRows)}`,
    );
    A(
      "D2b.4-dependency-auto-satisfied",
      finalRows.some((r) => r.package_name.endsWith("google-calendar-connector") && r.status === "active"),
      `google-calendar row present+active through the install (bundled image ⇒ dependency already satisfied): ${JSON.stringify(finalRows)}`,
    );

    // Install-batch ledger — the dependency-first evidence.
    const batches = await withDb((c) =>
      c
        .query(
          `select * from cinatra.extension_install_batches order by 1 desc limit 3`,
        )
        .then((r) => r.rows)
        .catch((e) => [{ error: String(e.message) }]),
    );
    steps.push(`install-batches=${JSON.stringify(batches).slice(0, 3000)}`);

    // The connector surface must render again after the marketplace install.
    const setupRes = await page.goto(
      `${BASE}/connectors/cinatra-ai/google-appointment-schedules-connector/setup`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page.waitForTimeout(2500);
    await shot(page, OUT, "08-setup-after-marketplace-install");
    const setupText = await page.locator("body").innerText();
    A(
      "D2b.5-setup-renders-after-install",
      setupRes?.status() === 200 && /Booking page URL|Appointment schedules/i.test(setupText),
      `status=${setupRes?.status()} text=${JSON.stringify(setupText.slice(0, 300))}`,
    );
  }
} catch (err) {
  assertions.push({ id: `D2b.${STAGE}.FATAL`, pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(
    `${OUT}/assertions.json`,
    JSON.stringify({ base: BASE, stage: STAGE, steps, assertions, toasts }, null, 2),
  );
  await browser.close();
}
