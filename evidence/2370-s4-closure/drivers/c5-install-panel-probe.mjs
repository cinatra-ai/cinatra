// C5 — open the appointment card's inline install panel and dump exactly what
// it offers (the panel re-renders, so everything is re-located after the click).
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c5");
const CARD_TITLE = "Google Appointment Schedules";
const steps = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();
await authenticate(context, steps);

await page.goto(`${BASE}/configuration/marketplace`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3500);

const cardSel = `[data-testid="extension-listing-card"]`;
const idx = await page.locator(cardSel).evaluateAll(
  (els, title) => els.findIndex((e) => (e.textContent || "").includes(title)),
  CARD_TITLE,
);
steps.push(`card index=${idx}`);
const card = page.locator(cardSel).nth(idx);
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await card.screenshot({ path: `${OUT}/01-card-before.png` });
const before = await card.evaluate((e) => e.outerHTML);

await card.locator('[data-testid="extension-install-panel-open"]').first().click();
await page.waitForTimeout(2500);

const card2 = page.locator(cardSel).nth(idx);
await card2.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
await card2.screenshot({ path: `${OUT}/02-card-after-open.png` }).catch(() => {});
const after = await card2.evaluate((e) => e.outerHTML).catch(() => "(card gone)");
const afterText = await card2.innerText().catch(() => "(no text)");

const pageTestids = await page.locator("[data-testid]").evaluateAll((els) =>
  [...new Set(els.map((e) => e.getAttribute("data-testid")))],
);
const dialogs = await page.locator('[role="dialog"]').allInnerTexts().catch(() => []);
const submitCount = await page.locator('[data-testid="extension-card-cta-submit"]').count();
const submitTexts = await page.locator('[data-testid="extension-card-cta-submit"]').allInnerTexts().catch(() => []);

await page.screenshot({ path: `${OUT}/03-page-after-open.png`, fullPage: false });

writeFileSync(
  `${OUT}/probe.json`,
  JSON.stringify(
    { steps, idx, afterText, pageTestids, dialogs, submitCount, submitTexts, beforeHtml: before.slice(0, 4000), afterHtml: after.slice(0, 8000) },
    null,
    2,
  ),
);
console.log("afterText:", afterText.slice(0, 800));
console.log("submitCount:", submitCount, submitTexts);
console.log("dialogs:", JSON.stringify(dialogs).slice(0, 600));
console.log("testids:", JSON.stringify(pageTestids));
await browser.close();
console.log("DRIVER-DONE");
