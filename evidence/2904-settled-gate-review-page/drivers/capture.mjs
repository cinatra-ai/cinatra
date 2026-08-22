// ---------------------------------------------------------------------------
// cinatra#2904 — THE CONFORMANCE RECORDER for the review page's gate region.
//
// Adapted from evidence/2791-s9g-conformance/drivers/capture.mjs, which is the
// shipped shape: it drives a real browser against the running lane app and
// writes each cell's record through the SHIPPED observer (`observeCapture`) over
// the SHIPPED Playwright port (`playwrightPage`). Nothing about frames, URLs or
// counts is written by this file — it says WHICH page to open, which host the
// cell claims and which kind/state it photographs, and the observer measures the
// rest.
//
// TWO THINGS THIS ROUND ADDS, and both matter to what is being proven:
//
//   `reload`  — the defect is in the review page's own SERVER LOADER, so a
//               picture taken in the tab that just pressed Approve would be
//               proving the client, not the page. A decided cell presses, waits
//               for the decision to land, and then RELOADS the route, so the
//               loader runs again on a gate it now finds RESOLVED. That reload
//               is the whole claim.
//
//   `panel`   — the unavailable case draws NO lifecycle card, so it cannot be a
//               card record: `observeCapture` would be asked to measure a card
//               that must not exist. A `panel` cell is measured with the same
//               page port and written to this directory's own results file
//               instead of the canonical index, carrying the counts that make it
//               a negative control: the blocked panel present, card DOM absent.
//
// Every origin, credential and path comes from the environment. Nothing about
// the lane host is written here.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// `@playwright/test` publishes CJS, so a dynamic import lands the namespace on
// `.default` on some resolutions and at the top level on others. Both are the
// same module; neither is guessed at.
const pwModule = await import(process.env.CAP_PLAYWRIGHT);
const pw = pwModule.chromium ? pwModule : pwModule.default;
const { playwrightPage } = await import(
  path.join(process.env.CAP_REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-driver.mjs")
);
const { observeCapture, captureRequirementsFor, validateCaptureRecord } = await import(
  path.join(process.env.CAP_REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-recorder.mjs")
);

const BASE = process.env.CAP_BASE;
const REPO = process.env.CAP_REPO_ROOT;
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const OUT = process.env.CAP_OUT_JSON;

const cookies = IDS.cookie.split("; ").map((c) => {
  const i = c.indexOf("=");
  return { name: c.slice(0, i), value: c.slice(i + 1), domain: new URL(BASE).hostname, path: "/" };
});

/** The kind+state specs the CI half asks for that the host set does not carry. */
function extraSpecsFor(host, kind, state) {
  if (host === "chat_thread") return [];
  const base = captureRequirementsFor(host);
  const full = captureRequirementsFor(host, kind, state);
  const key = (s) => `${s.frame}::${s.scope}::${s.within ?? ""}::${s.selector}::${s.expect}`;
  const have = new Set(base.map(key));
  return full.filter((s) => !have.has(key(s)));
}

const sha = (rel) =>
  createHash("sha256").update(fs.readFileSync(path.join(REPO, rel))).digest("hex");

/** The anchors a `panel` cell writes down — counted, never assumed. */
const PANEL_SELECTORS = [
  '[data-conformance-id="review-gate-blocked"]',
  '[data-action="refresh-gate -> live-gate"]',
  '[data-lifecycle-card="artifact_review_gate"]',
  '[data-lifecycle-card-host="page_gate_region"]',
  '[data-conformance-id="review-gate-settled"]',
  "[data-review-outcome]",
  '[data-conformance-id="review-decision-bar"]',
  '[data-conformance-id="review-not-authorized"]',
];

const records = [];
const panels = [];
const failures = [];
const browser = await pw.chromium.launch({ headless: true });

for (const cell of PLAN) {
  const ctx = await browser.newContext({
    viewport: { width: cell.width ?? 1228, height: cell.height ?? 1400 },
    deviceScaleFactor: 2,
    colorScheme: cell.dark ? "dark" : "light",
  });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  if (cell.dark) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("theme", "dark");
      } catch {}
    });
  }
  try {
    await page.goto(BASE + cell.path, { waitUntil: "domcontentloaded", timeout: 180000 });
    if (cell.waitFor) {
      await page.waitForSelector(cell.waitFor, { timeout: 180000 }).catch(() => {});
    }
    await page.waitForTimeout(cell.settleMs ?? 12000);
    // The dev overlay is chrome, not the product. Removed before the shutter so
    // it cannot sit over the card in the picture.
    const stripOverlay = () =>
      page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
    await stripOverlay();

    // THE REAL DECISION, when the cell takes one: the card's OWN control, in the
    // browser, on this screen. Nothing here writes a gate row.
    if (cell.press) {
      await page.locator(cell.press).first().click({ timeout: 60000 });
      await page.waitForTimeout(cell.afterPressMs ?? 15000);
    }
    // THE RELOAD IS THE CLAIM: the route's server loader runs again, and what it
    // now answers for a RESOLVED gate is what this round is about.
    if (cell.reload) {
      await page.goto(BASE + cell.path, { waitUntil: "domcontentloaded", timeout: 180000 });
      if (cell.waitForAfterReload) {
        await page.waitForSelector(cell.waitForAfterReload, { timeout: 180000 }).catch(() => {});
      }
      await page.waitForTimeout(cell.settleMs ?? 12000);
    }
    await stripOverlay();

    const documentClass = await page.evaluate(() => document.documentElement.className);

    if (cell.panel) {
      // Not a card cell. Measured with the same port, written HERE.
      const counts = {};
      for (const selector of PANEL_SELECTORS) {
        counts[selector] = await page.locator(selector).count();
      }
      await page.screenshot({ path: path.join(REPO, cell.screenshot), fullPage: false });
      panels.push({
        cell: cell.cell,
        finalUrl: new URL(page.url()).pathname,
        screenshot: cell.screenshot,
        sha256: sha(cell.screenshot),
        documentClass,
        counts,
        note: cell.note ?? null,
      });
      console.log(`PANEL ${cell.cell} ${JSON.stringify(counts)}`);
      continue;
    }

    const record = await observeCapture({
      page: playwrightPage(page),
      cell: cell.cell,
      declaredHost: cell.declaredHost,
      kind: cell.kind,
      state: cell.state,
      instance: cell.instance ?? null,
      screenshot: cell.screenshot,
      build: "development",
      extraAssertions: [
        ...extraSpecsFor(cell.declaredHost, cell.kind, cell.state),
        // The anchors THIS round is about, counted INSIDE the card's own root so
        // a marker borrowed from another card on the same screen cannot answer
        // for this one. Same root as the required specs — a record pins ONE card.
        //
        // EACH CARRIES ITS OWN `expect`, and that is the cell's CLAIM: a pending
        // cell claims the settled anchors are ABSENT, a decided cell claims they
        // are present and the blocked panel's are absent. `validateCaptureRecord`
        // refuses the record when the page disagrees, so the claim is checked
        // against the screen rather than written down beside it.
        ...(cell.extraAnchors ?? []).map(({ selector, expect }) => ({
          selector,
          scope: "root",
          within: '[data-lifecycle-card="artifact_review_gate"]',
          expect,
        })),
      ],
      repoRoot: REPO,
    });
    record.runtime = process.env.CAP_RUNTIME ?? "dev-runtime";
    record.documentClass = documentClass;
    if (cell.note) record.note = cell.note;
    const v = validateCaptureRecord(record, { hashOf: sha, tier: "audit" });
    if (v.length > 0) {
      failures.push({ cell: cell.cell, violations: v });
      console.log(`FAILED ${cell.cell}`);
      for (const line of v) console.log(`   ${JSON.stringify(line)}`);
    } else {
      records.push(record);
      console.log(
        `OK ${cell.cell} (${record.declaredHost}/${record.declaredKind}/${record.declaredState}) class=${documentClass}`,
      );
    }
  } catch (err) {
    failures.push({ cell: cell.cell, violations: [String(err?.message ?? err)] });
    console.log(`THREW ${cell.cell}: ${err?.message ?? err}`);
  } finally {
    await ctx.close();
  }
}

await browser.close();
fs.writeFileSync(OUT, JSON.stringify({ records, panels, failures }, null, 2));
console.log(`RECORDS ${records.length} PANELS ${panels.length} FAILURES ${failures.length}`);
