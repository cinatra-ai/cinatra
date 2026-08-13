// S7 (cinatra#2573) — per-surface / per-card / per-state conformance capture.
//
// Runs on host2 against a PRODUCTION-EQUIVALENT build (`pnpm build` +
// `next start`), against REAL lifecycle rows written by the shipped stores in an
// earlier proof round. Nothing here writes a row; it signs in as the run's own
// owner and photographs what the shipped surfaces draw.
//
// Each captured cell records the conformance anchors present in the DOM and the
// card's own `data-lifecycle-card-state`, so a screenshot is never the only
// evidence: the JSON beside it says what the page actually asserted.
//
// Usage: node conformance-capture.mjs <baseUrl> <outDir>

import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = process.argv[3] || "/tmp/s7-conformance";
mkdirSync(OUT, { recursive: true });

const ACTOR = { email: "cinatra-uat@example.com", password: "cinatra-uat-dev-12345" };
// The saved session for that same actor, established by the wp-drupal-uat
// global-setup. Preferred over driving the form: it is the SAME principal, and a
// sign-in form change must not be able to fail an acceptance capture.
const STATE = "tests/e2e/wp-drupal-uat/.auth/state.json";

const RUN_ID = "run-ff2087fd-0872-4745-ae8b-f576d41f35aa";
const VENDOR = "proof";
const PKG = "tmpl-s8f-41f7b2ca-0413-4988-94e0-5ec0040081ac";

// review_task_ids on that run, by the state they should draw.
const PENDING_REPAIR = "lifecycle-review:repair:9e8e8b2c-24c1-41fa-a7c7-7b96448b7a7a:1";
const PENDING_VERIFY = "lifecycle-review:verify:verify:b7613839-f997-4b1d-96dc-0fde7ce2f3f0";
const RESOLVED = "s8f-seed-review-a8817589-ab60-4838-8145-1a53960dbe2e";

const reviewUrl = (taskId, q = "") =>
  `${BASE}/agents/${VENDOR}/${PKG}/${encodeURIComponent(RUN_ID)}/review/${encodeURIComponent(taskId)}${q}`;

const cells = [
  {
    id: "review-card__page_gate_region__pending",
    card: "artifact_review_gate",
    surface: "page_gate_region",
    state: "pending",
    url: reviewUrl(PENDING_REPAIR),
    waitFor: '[data-conformance-id="review-gate-card"], [data-conformance-id="review-target"]',
  },
  {
    id: "review-card__page_gate_region__settled",
    card: "artifact_review_gate",
    surface: "page_gate_region",
    state: "settled",
    url: reviewUrl(RESOLVED),
    waitFor: '[data-conformance-id="review-gate-blocked"], [data-conformance-id="review-gate-card"], main',
  },
  {
    id: "verification-card__page_gate_region__advisory",
    card: "verification_summary",
    surface: "page_gate_region",
    state: "advisory",
    // The verification record is bound to the gate whose OWN review_task_id is
    // the repair task — `verify:<gateId>` names the gate, not the successor.
    url: reviewUrl(PENDING_REPAIR, "?view=verification"),
    waitFor: "main",
  },
  {
    id: "island__first_party__server_rendered",
    card: "artifact_review_gate",
    surface: "review_target_island",
    state: "rendered",
    // Filled in at run time from the ref the page-hosted card actually minted —
    // the island is addressed only by a server-minted ref, and forging one is
    // exactly what it refuses.
    url: null,
    waitFor: '[data-conformance-id="review-target-island-body"], [data-conformance-id="review-target-island-empty"], body',
  },
  {
    id: "island__forged_ref__empty",
    card: "artifact_review_gate",
    surface: "review_target_island",
    state: "absent",
    url: `${BASE}/lifecycle/review-island?ref=not-a-real-ref`,
    waitFor: "body",
  },
  {
    id: "review-card__run_card__host",
    card: "artifact_review_gate",
    surface: "run_card",
    state: "host-render",
    url: `${BASE}/agents/${VENDOR}/${PKG}/${encodeURIComponent(RUN_ID)}`,
    waitFor: '[data-conformance-id="run-surface"], main',
  },
];

async function signIn(page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60_000 });
  await page.fill('input[type="email"], input[name="email"]', ACTOR.email);
  await page.fill('input[type="password"], input[name="password"]', ACTOR.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 120_000 });
}

const browser = await chromium.launch({ headless: true });
const useState = existsSync(STATE);
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ...(useState ? { storageState: STATE } : {}),
});
const page = await ctx.newPage();

const results = [];
try {
  // Verify the restored session is live; fall back to the form if it is not.
  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  let signedIn = !new URL(page.url()).pathname.startsWith("/sign-in");
  if (!signedIn) {
    await signIn(page);
    signedIn = !new URL(page.url()).pathname.startsWith("/sign-in");
  }
  await page.screenshot({ path: join(OUT, "__session.png"), fullPage: true });
  results.push({ id: "__session", finalUrl: page.url(), signedIn, usedSavedState: useState });
  if (!signedIn) throw new Error("not signed in — every capture below would be the sign-in page");

  let mintedIslandRef = null;
  for (const cell of cells) {
    if (cell.id === "island__first_party__server_rendered") {
      if (!mintedIslandRef) {
        results.push({ ...cell, skipped: "no island ref was minted by an earlier cell" });
        continue;
      }
      cell.url = `${BASE}${mintedIslandRef}`;
    }
    const errors = [];
    const onErr = (e) => errors.push(String(e.message ?? e));
    page.on("pageerror", onErr);
    let status = null;
    try {
      const resp = await page.goto(cell.url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      status = resp && resp.status();
      await page.waitForSelector(cell.waitFor, { state: "visible", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2500);
    } catch (e) {
      errors.push(`nav: ${e.message}`);
    }
    const shot = join(OUT, `${cell.id}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const anchors = await page
      .$$eval("[data-conformance-id]", (els) => [...new Set(els.map((e) => e.getAttribute("data-conformance-id")))])
      .catch(() => []);
    const cardStates = await page
      .$$eval("[data-lifecycle-card-state]", (els) => els.map((e) => e.getAttribute("data-lifecycle-card-state")))
      .catch(() => []);
    const islandFrames = await page
      .$$eval("iframe", (els) => els.map((e) => ({ src: e.getAttribute("src"), sandbox: e.getAttribute("sandbox") })))
      .catch(() => []);
    const heading = await page.locator("h1,h2").first().textContent().catch(() => null);
    page.off("pageerror", onErr);
    if (!mintedIslandRef && islandFrames.length > 0 && islandFrames[0].src) {
      mintedIslandRef = islandFrames[0].src;
    }
    results.push({
      ...cell,
      httpStatus: status,
      finalUrl: page.url(),
      screenshot: shot,
      heading: heading && heading.trim().slice(0, 120),
      conformanceAnchors: anchors.sort(),
      lifecycleCardStates: cardStates,
      islandFrames,
      pageErrors: errors,
    });
    console.log(`captured ${cell.id} -> ${shot} (anchors: ${anchors.length}, cardStates: ${JSON.stringify(cardStates)})`);
  }
} finally {
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), results }, null, 2));
  await browser.close();
}
console.log("done");
