/**
 * The capture path for the cinatra#2833 / #2835 notification proofs.
 *
 * ANCHOR DOCTRINE. Every picture is preceded by a live read of the element's OWN
 * identifying attributes, written into the log beside it: the bell's
 * `aria-label` (which carries the badge count the component itself computes),
 * the feed's `data-conformance-id="notifications-list"` and each row's
 * `data-conformance-id="notification-row"` + `data-field="item.title"`, and the
 * landing URL after the click-through. A file name carries no authority; the log
 * line does.
 *
 * Usage: node evidence/.../capture.mjs <baseUrl> <outDir> <stateJson> <cell> [arg]
 */
import { chromium } from "@playwright/test";
import { mkdirSync, appendFileSync } from "node:fs";

const [, , BASE, OUT, STATE, CELL, ARG, ARG2] = process.argv;
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}/capture-log.txt`;
const say = (m) => {
  appendFileSync(LOG, `${m}\n`);
  console.log(m);
};

/** Read the bell off its own attributes — never off a screenshot. */
async function bellAnchors(page) {
  return page.evaluate(() => {
    const bell = document.querySelector('a[aria-label^="Notifications"]');
    if (!bell) return { present: false };
    const badge = bell.querySelector("span,div");
    return {
      present: true,
      ariaLabel: bell.getAttribute("aria-label"),
      href: bell.getAttribute("href"),
      badgeText: badge ? badge.textContent.trim() : null,
    };
  });
}

/** Read the feed off its own conformance ids. */
async function feedAnchors(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-conformance-id="notifications-list"]');
    const rows = [...document.querySelectorAll('[data-conformance-id="notification-row"]')];
    return {
      listPresent: Boolean(list),
      rowCount: rows.length,
      rows: rows.map((r) => ({
        title: r.querySelector('[data-field="item.title"]')?.textContent?.trim() ?? null,
        href: r.querySelector('a[data-action^="activate"]')?.getAttribute("href") ?? null,
        // The row carries no per-notification key attribute, so its own visible
        // timestamp is the finest identity the DOM offers; the dedupe keys read
        // straight out of the database are logged beside every picture.
        stamp: (r.innerText.split("\n").map((x) => x.trim()).filter(Boolean).pop()) ?? null,
      })),
    };
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  storageState: STATE,
});
const page = await ctx.newPage();

async function goto(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(() => {});
}

try {
  say(`\n===== CELL ${CELL} (${new Date().toISOString()}) arg=${ARG ?? "-"}`);

  if (CELL === "bell") {
    await goto(`${BASE}/agents`);
    // The badge is derived client-side from the store; give the poll one beat.
    await page.waitForTimeout(3000);
    const a = await bellAnchors(page);
    say(`bell anchors: ${JSON.stringify(a)}`);
    say(`url: ${page.url()}`);
    await page.locator('a[aria-label^="Notifications"]').screenshot({ path: `${OUT}/${ARG}-bell.png` });
    await page.screenshot({ path: `${OUT}/${ARG}-bell-page.png` });
  }

  if (CELL === "list") {
    await goto(`${BASE}/notifications`);
    await page.waitForTimeout(2000);
    const f = await feedAnchors(page);
    say(`feed anchors: ${JSON.stringify(f)}`);
    say(`url: ${page.url()}`);
    await page.screenshot({ path: `${OUT}/${ARG}-list.png`, fullPage: true });
  }

  if (CELL === "click") {
    await goto(`${BASE}/notifications`);
    await page.waitForTimeout(2000);
    const f = await feedAnchors(page);
    say(`feed anchors before click: ${JSON.stringify(f)}`);
    const target = page
      .locator(`[data-conformance-id="notification-row"] a[data-action^="activate"][href*="${ARG}"]`)
      .first();
    const href = await target.getAttribute("href");
    say(`clicking the row whose activate link is ${href}`);
    await target.click();
    await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    say(`landed on: ${page.url()}`);
    const rail = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[data-conformance-id]")].map((e) =>
        e.getAttribute("data-conformance-id"),
      );
      return { conformanceIds: [...new Set(els)].slice(0, 40) };
    });
    say(`landing conformance ids: ${JSON.stringify(rail)}`);
    await page.screenshot({ path: `${OUT}/${ARG}-click-through.png`, fullPage: true });
  }

  if (CELL === "review") {
    // ARG is the run-page path; the Review rail entry is read off the page's own
    // link rather than reconstructed, so the chain the notification starts is the
    // chain that was actually walked.
    await goto(`${BASE}${ARG}`);
    await page.waitForTimeout(5000);
    // ARG2 narrows the rail to ONE entry (the run carries several reviews); the
    // href is still READ OFF the page, never reconstructed.
    const reviewHrefs = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll("a")].map((x) => x.getAttribute("href")))].filter(
        (h) => h && h.includes("/review/"),
      ),
    );
    const reviewHref = ARG2 ? reviewHrefs.find((h) => h.includes(ARG2)) ?? null : reviewHrefs[0] ?? null;
    say(`run page: ${page.url()}`);
    say(`Review rail entries on the run page: ${JSON.stringify(reviewHrefs)}`);
    say(`Review rail entry followed: ${reviewHref}`);
    await page.screenshot({ path: `${OUT}/2833-batch-run-page.png`, fullPage: true });
    if (!reviewHref) throw new Error("no review entry on the run page");
    await goto(`${BASE}${reviewHref}`);
    await page.waitForTimeout(5000);
    const ids = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll("[data-conformance-id]")].map((e) => e.getAttribute("data-conformance-id"))),
    ]);
    say(`review page: ${page.url()}`);
    say(`review page conformance ids: ${JSON.stringify(ids)}`);
    await page.screenshot({ path: `${OUT}/2833-batch-review-page.png`, fullPage: true });
  }

  if (CELL === "decide") {
    await goto(`${BASE}${ARG}`);
    await page.waitForTimeout(6000);
    say(`deciding on: ${page.url()}`);
    const approve = page.locator('button:has-text("Approve")').first();
    await approve.waitFor({ state: "visible", timeout: 60_000 });
    await approve.click();
    await page.waitForTimeout(8000);
    say(`after Approve, url: ${page.url()}`);
    const ids = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll("[data-conformance-id]")].map((e) => e.getAttribute("data-conformance-id"))),
    ]);
    say(`review page conformance ids after Approve: ${JSON.stringify(ids)}`);
    await page.screenshot({ path: `${OUT}/2833-batch-decided.png`, fullPage: true });
  }

  if (CELL === "confirm") {
    // ARG is the run-page path the notification linked to. The decision is taken
    // on the CARD ITSELF, on the surface the notification delivered the reader to.
    await goto(`${BASE}${ARG}`);
    await page.waitForTimeout(6000);
    const before = await page.evaluate(() => {
      const row = document.querySelector('[data-conformance-id="run-chip-row"]');
      return {
        chipRowPresent: Boolean(row),
        chips: [...document.querySelectorAll("[data-skill-id]")].map((c) => ({
          skillId: c.getAttribute("data-skill-id"),
          selected: c.getAttribute("data-selected"),
        })),
        buttons: [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean),
      };
    });
    say(`run page: ${page.url()}`);
    say(`chip-row anchors before the decision: ${JSON.stringify(before)}`);
    await page.screenshot({ path: `${OUT}/2835-hold-card.png`, fullPage: true });
    const confirm = page.locator('button:has-text("Confirm")').first();
    await confirm.waitFor({ state: "visible", timeout: 60_000 });
    await confirm.click();
    await page.waitForTimeout(10_000);
    const after = await page.evaluate(() => ({
      chipRowPresent: Boolean(document.querySelector('[data-conformance-id="run-chip-row"]')),
      buttons: [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean),
    }));
    say(`after Confirm, url: ${page.url()}`);
    say(`chip-row anchors after the decision: ${JSON.stringify(after)}`);
    await page.screenshot({ path: `${OUT}/2835-hold-confirmed.png`, fullPage: true });
  }

  if (CELL === "gone") {
    await goto(`${BASE}/notifications`);
    await page.waitForTimeout(2000);
    const f = await feedAnchors(page);
    say(`feed anchors after the decision: ${JSON.stringify(f)}`);
    const stillThere = f.rows.filter((r) => (r.href ?? "").includes(ARG ?? "@@none@@"));
    say(`rows still pointing at ${ARG}: ${stillThere.length}`);
    await page.screenshot({ path: `${OUT}/${ARG}-row-gone.png`, fullPage: true });
    const a = await bellAnchors(page);
    say(`bell anchors after the decision: ${JSON.stringify(a)}`);
  }

  if (CELL === "url") {
    await goto(`${BASE}${ARG}`);
    await page.waitForTimeout(3000);
    say(`url: ${page.url()}`);
    const ids = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll("[data-conformance-id]")].map((e) => e.getAttribute("data-conformance-id"))),
    ]);
    say(`conformance ids: ${JSON.stringify(ids.slice(0, 60))}`);
    const buttons = await page.$$eval("button", (e) => e.map((x) => x.textContent?.trim()).filter(Boolean).slice(0, 40));
    say(`buttons: ${JSON.stringify(buttons)}`);
    await page.screenshot({ path: `${OUT}/probe.png`, fullPage: true });
  }
} finally {
  await browser.close();
}
