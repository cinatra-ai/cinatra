// ---------------------------------------------------------------------------
// cinatra#2791 (S9g) — THE CONFORMANCE RECORDER.
//
// It drives a real browser against the running lane app and writes each cell's
// record through the SHIPPED observer (`observeCapture`) over the SHIPPED
// Playwright port (`playwrightPage`). Nothing about frames, URLs or counts is
// written by this file: it says WHICH page to open, which host the cell claims
// and which kind/state it photographs, and the observer measures the rest.
//
// WHY THE EXTRA SPECS. `observeCapture` derives its own requirement set from the
// KIND only for `chat_thread`; the other three hosts get the host-level set. The
// ratified CI contract (`scripts/ci/lib/capture-record-contract.mjs`) judges
// EVERY host against the kind and the state, so a run_card / page_gate_region /
// site_widget record built from the host set alone is missing exactly the
// anchors that half will ask for. So the delta between
// `captureRequirementsFor(host, kind, state)` and `captureRequirementsFor(host)`
// is handed in as `extraAssertions` — the SAME specs, from the SAME function,
// never a second hand-written list.
//
// PICTURE AND COUNTS ARE THE OBSERVER'S: it measures, shoots, and measures
// again, and refuses a cell whose screen moved between the two.
//
// Every origin, credential and path comes from the environment. Nothing about
// the lane host is written here.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const pw = await import(process.env.CAP_PLAYWRIGHT);
const { playwrightPage } = await import(
  path.join(process.env.CAP_REPO_ROOT, "scripts/audit/lib/chat-hitl-capture-driver.mjs")
);
const {
  observeCapture,
  captureRequirementsFor,
  validateCaptureRecord,
} = await import(
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
  // `observeCapture` already derives the kind+state set for chat_thread; asking
  // for it again would record every anchor twice.
  if (host === "chat_thread") return [];
  const base = captureRequirementsFor(host);
  const full = captureRequirementsFor(host, kind, state);
  const key = (s) => `${s.frame}::${s.scope}::${s.within ?? ""}::${s.selector}::${s.expect}`;
  const have = new Set(base.map(key));
  return full.filter((s) => !have.has(key(s)));
}

const results = [];
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
    await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));

    // THE REAL INTERACTION, when the cell has one. A decided cell is DECIDED by
    // pressing the card's own control, in the browser, on this screen.
    if (cell.press) {
      if (cell.typeInto) {
        await page.locator(cell.typeInto).first().fill(cell.typeText ?? "");
      }
      if (cell.pressAll) {
        // §V decides PER CHIP: the row settles when every chip has been
        // answered, so every one of them is pressed, in the browser, in order.
        const n = await page.locator(cell.press).count();
        for (let i = 0; i < n; i += 1) {
          await page.locator(cell.press).first().click({ timeout: 60000 });
          await page.waitForTimeout(cell.betweenPressMs ?? 2500);
        }
      } else {
        await page.locator(cell.press).first().click({ timeout: 60000 });
      }
      await page.waitForTimeout(cell.afterPressMs ?? 15000);
      await page.evaluate(() =>
        document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()),
      );
    }
    if (cell.scrollToFoot !== false) {
      await page.evaluate(() => {
        const l = document.querySelector("[data-conversation-list]");
        for (const el of [l, l?.closest("[class*=overflow]"), l?.parentElement]) {
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
      await page.waitForTimeout(2000);
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
      extraAssertions: extraSpecsFor(cell.declaredHost, cell.kind, cell.state),
      repoRoot: REPO,
    });
    record.runtime = "dev-runtime";
    if (cell.note) record.note = cell.note;
    const v = validateCaptureRecord(record, {
      hashOf: (rel) =>
        createHash("sha256").update(fs.readFileSync(path.join(REPO, rel))).digest("hex"),
      tier: "audit",
    });
    if (v.length > 0) {
      failures.push({ cell: cell.cell, violations: v });
      console.log(`FAILED ${cell.cell}`);
      for (const line of v) console.log(`   ${line}`);
    } else {
      results.push(record);
      console.log(`OK ${cell.cell} (${record.declaredHost}/${record.declaredKind}/${record.declaredState})`);
    }
  } catch (err) {
    failures.push({ cell: cell.cell, violations: [String(err?.message ?? err)] });
    console.log(`THREW ${cell.cell}: ${err?.message ?? err}`);
  } finally {
    await ctx.close();
  }
}

await browser.close();
fs.writeFileSync(OUT, JSON.stringify({ records: results, failures }, null, 2));
console.log(`RECORDS ${results.length} FAILURES ${failures.length}`);
