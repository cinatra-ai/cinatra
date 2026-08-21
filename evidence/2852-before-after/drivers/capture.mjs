// ---------------------------------------------------------------------------
// The lifecycle-card CAPTURE RECORDER (cinatra#2821's capture-record contract).
//
// One run against the LIVE app: it drives the shipped surface, screenshots the
// card ROOT (framed off `[data-conformance-id="review-gate-card"]`, never a
// hand-picked box), and writes a RECORD for every picture in the shape
// `scripts/ci/lib/capture-record-contract.mjs` validates — the declared host,
// the FINAL url, the sha256 of the bytes on disk, and every anchor it actually
// looked for with the count it actually saw.
//
// COUNTING RULES, stated because the contract's `scope` words are the whole
// evidentiary value and a reader must be able to re-derive every number:
//   page  — `document.querySelectorAll(sel).length` on the top document.
//   frame — the same, on the document the picture was taken in (here: the top
//           document; the island `<iframe>` is a separate document and is
//           never counted as the card's own).
//   root  — the card root's OWN subtree INCLUDING the root element itself:
//           `root.matches(sel) + root.querySelectorAll(sel).length`. The root
//           carries `data-lifecycle-card-state` on itself, and `querySelectorAll`
//           does not match its receiver, so excluding the root would report 0
//           for a marker that is plainly on the card.
//
// Never invents a number: an anchor the recorder does not look for is absent
// from the record, and an anchor it looks for and does not find is written as 0.
// ---------------------------------------------------------------------------
// The playwright module is resolved by PATH (CAP_PLAYWRIGHT), so this driver
// runs from an evidence directory without a package.json of its own.
const pw = await import(process.env.CAP_PLAYWRIGHT);
const chromium = (pw.chromium ?? pw.default?.chromium);
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CAP_BASE;
const OUT_DIR = process.env.CAP_OUT_DIR;           // absolute, where PNGs land
const REPO_ROOT = process.env.CAP_REPO_ROOT;       // absolute worktree root
const IDS = JSON.parse(fs.readFileSync(process.env.IDS_JSON, "utf8"));
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const RECORDS_OUT = process.env.CAP_RECORDS_OUT;

const CARD_ROOT = '[data-conformance-id="review-gate-card"]';

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1228, height: 1400 },
  deviceScaleFactor: 2,
});
await ctx.addCookies(
  IDS.cookie.split("; ").map((c) => {
    const i = c.indexOf("=");
    return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
  }),
);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

async function counts(selectors) {
  return page.evaluate(
    ({ sels, rootSel }) => {
      const root = document.querySelector(rootSel);
      const out = [];
      for (const { selector, scope } of sels) {
        let count = 0;
        if (scope === "root") {
          count = root ? (root.matches(selector) ? 1 : 0) + root.querySelectorAll(selector).length : 0;
        } else {
          count = document.querySelectorAll(selector).length;
        }
        out.push({ selector, scope, count });
      }
      return out;
    },
    { sels: selectors, rootSel: CARD_ROOT },
  );
}

const records = [];
const results = [];

for (const cell of PLAN.cells) {
  pageErrors.length = 0;
  const url = BASE + cell.path;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.waitForLoadState("load").catch(() => {});
  // The card renders NOTHING until its authoritative resolve answers, so wait
  // for the root rather than a fixed sleep.
  let rootPresent = true;
  try {
    await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 90000 });
  } catch {
    rootPresent = false;
  }
  // The target island is a same-origin <iframe>; wait for ITS document to paint
  // so the card is photographed with its target, not with the island skeleton.
  const iframeEl = await page.$(`${CARD_ROOT} iframe`);
  if (iframeEl) {
    const frame = await iframeEl.contentFrame();
    if (frame) {
      await frame
        .locator('[data-conformance-id="review-target-island-body"], [data-conformance-id="review-target-island-empty"]')
        .first()
        .waitFor({ state: "attached", timeout: 120000 })
        .catch(() => {});
    }
  }
  await page.waitForTimeout(cell.settleMs ?? 6000);

  if (cell.action === "approve") {
    const btn = page.getByRole("button", { name: /^Approve$/i }).last();
    await btn.click();
    // The settled panel is what the decision produces; wait for IT rather than
    // for a clock. On the review PAGE the server action also revalidates the
    // route, which replaces the whole card with the route's own blocked panel —
    // so the settled card is photographed in the window it exists in, and if it
    // is gone by then the record says root=0 rather than pretending otherwise.
    await page
      .locator('[data-conformance-id="review-gate-settled"], [data-conformance-id="review-gate-blocked"]')
      .first()
      .waitFor({ state: "attached", timeout: cell.actionSettleMs ?? 20000 })
      .catch(() => {});
    await page.waitForTimeout(cell.postActionMs ?? 800);
  }
  if (cell.action === "toggleFirstChip") {
    const chip = page.locator(cell.chipSelector).first();
    await chip.click();
    await page.waitForTimeout(1200);
  }
  if (cell.action === "toggleChips") {
    for (const step of cell.chipSteps ?? []) {
      const chip = page.locator(step.selector).nth(step.index ?? 0);
      for (let i = 0; i < (step.clicks ?? 1); i += 1) {
        await chip.click();
        await page.waitForTimeout(700);
      }
    }
    await page.waitForTimeout(1500);
  }

  // The record carries the URL PATH, never the origin: the contract classes a
  // capture by its path, and a host name is not evidence.
  const finalUrl = new URL(page.url()).pathname + (new URL(page.url()).search || "");
  const observed = await counts(cell.assertions ?? []);
  const shotRel = path.posix.join(cell.dir, `${cell.cell}.png`);
  const shotAbs = path.join(REPO_ROOT, shotRel);
  fs.mkdirSync(path.dirname(shotAbs), { recursive: true });

  const root = page.locator(CARD_ROOT).first();
  const rootCount = await page.locator(CARD_ROOT).count();
  if (rootCount > 0 && !cell.fullPage) {
    await root.screenshot({ path: shotAbs, scale: "device" });
  } else {
    await page.screenshot({ path: shotAbs, fullPage: true, scale: "device" });
  }

  const bytes = fs.readFileSync(shotAbs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = (() => {
    // PNG IHDR: width/height are big-endian uint32 at bytes 16..24
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  })();

  const text = rootCount > 0 ? (await root.innerText()).replace(/\n{2,}/g, "\n") : "";

  records.push({
    cell: cell.cell,
    declaredHost: cell.declaredHost,
    declaredKind: cell.declaredKind,
    declaredState: cell.declaredState,
    finalUrl,
    screenshot: shotRel,
    sha256,
    assertions: observed,
    recordedBy: PLAN.recordedBy,
    recordedAt: new Date().toISOString(),
    runtime: PLAN.runtime,
    note: cell.note,
  });
  results.push({
    cell: cell.cell,
    requestedPath: cell.path,
    finalUrl,
    httpStatus: resp?.status() ?? null,
    rootPresent,
    rootCount,
    pixels: dims,
    sha256,
    observed,
    cardText: text.slice(0, 1200),
    pageErrors: [...pageErrors],
  });
  console.log(`CAP ${cell.cell} ${dims.width}x${dims.height} root=${rootCount} url=${finalUrl}`);
}

fs.writeFileSync(RECORDS_OUT, JSON.stringify({ records, results }, null, 2));
await browser.close();
console.log("CAP DONE", RECORDS_OUT);
