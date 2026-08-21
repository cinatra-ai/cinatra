// ---------------------------------------------------------------------------
// The lifecycle-card CAPTURE RECORDER for cinatra#2841 (§V redraw).
//
// Adapted from evidence/2852-before-after/drivers/capture.mjs. One run against
// the LIVE app: it drives the shipped surface, screenshots the card ROOT
// (framed off the plan's `cardRoot`, never a hand-picked box), and writes a
// RECORD for every picture in the shape scripts/ci/lib/capture-record-contract.mjs
// validates — the declared host, the FINAL url, the sha256 of the bytes on
// disk, and every anchor it actually looked for with the count it actually saw.
//
// COUNTING RULES (unchanged from the 2852 recorder, restated so every number
// here is re-derivable):
//   page  — document.querySelectorAll(sel).length on the top document.
//   frame — the same, on the document the picture was taken in.
//   root  — the card root's OWN subtree INCLUDING the root element:
//           root.matches(sel) + root.querySelectorAll(sel).length.
//
// Never invents a number: an anchor the recorder does not look for is absent
// from the record, and an anchor it looks for and does not find is written 0.
// ---------------------------------------------------------------------------
const pw = await import(process.env.CAP_PLAYWRIGHT);
const chromium = pw.chromium ?? pw.default?.chromium;
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CAP_BASE;
const OUT_DIR = process.env.CAP_OUT_DIR;
const REPO_ROOT = process.env.CAP_REPO_ROOT;
const PLAN = JSON.parse(fs.readFileSync(process.env.CAP_PLAN, "utf8"));
const RECORDS_OUT = process.env.CAP_RECORDS_OUT;

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const records = [];
const results = [];

for (const cell of PLAN.cells) {
  const cardRoot = cell.cardRoot ?? PLAN.cardRoot;
  const ctx = await browser.newContext({
    viewport: { width: PLAN.viewportWidth ?? 1228, height: cell.viewportHeight ?? 1400 },
    deviceScaleFactor: 2,
    colorScheme: cell.colorScheme ?? "light",
  });
  const cookie = cell.cookie ?? PLAN.cookie;
  await ctx.addCookies(
    cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
    }),
  );
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  const counts = (selectors) =>
    page.evaluate(
      ({ sels, rootSel }) => {
        const root = document.querySelector(rootSel);
        const out = [];
        for (const { selector, scope } of sels) {
          let count = 0;
          if (scope === "root") {
            count = root
              ? (root.matches(selector) ? 1 : 0) + root.querySelectorAll(selector).length
              : 0;
          } else {
            count = document.querySelectorAll(selector).length;
          }
          out.push({ selector, scope, count });
        }
        return out;
      },
      { sels: selectors, rootSel: cardRoot },
    );

  const url = BASE + cell.path;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
  await page.waitForLoadState("load").catch(() => {});
  let rootPresent = true;
  try {
    await page.locator(cardRoot).first().waitFor({ state: "attached", timeout: 120000 });
  } catch {
    rootPresent = false;
  }
  await page.waitForTimeout(cell.settleMs ?? 4000);

  for (const step of cell.steps ?? []) {
    if (step.click) {
      await page
        .locator(step.click)
        .nth(step.index ?? 0)
        .click({ timeout: step.timeout ?? 20000 });
    }
    if (step.waitFor) {
      await page
        .locator(step.waitFor)
        .first()
        .waitFor({ state: step.state ?? "attached", timeout: step.timeout ?? 20000 })
        .catch(() => {});
    }
    await page.waitForTimeout(step.waitMs ?? 900);
  }
  if (cell.reloadAfterSteps) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 240000 });
    await page.locator(cardRoot).first().waitFor({ state: "attached", timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(cell.reloadSettleMs ?? 6000);
  }
  await page.waitForTimeout(cell.postMs ?? 1200);

  const finalUrl = new URL(page.url()).pathname + (new URL(page.url()).search || "");
  const observed = await counts(cell.assertions ?? []);
  const shotRel = path.posix.join(cell.dir, `${cell.cell}.png`);
  const shotAbs = path.join(REPO_ROOT, shotRel);
  fs.mkdirSync(path.dirname(shotAbs), { recursive: true });

  const frameSel = cell.frameOn ?? cardRoot;
  const frameCount = await page.locator(frameSel).count();
  if (frameCount > 0 && !cell.fullPage) {
    await page.locator(frameSel).first().screenshot({ path: shotAbs, scale: "device" });
  } else {
    await page.screenshot({ path: shotAbs, fullPage: cell.fullPage !== false, scale: "device" });
  }

  const bytes = fs.readFileSync(shotAbs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const rootCount = await page.locator(cardRoot).count();
  const chips = await page.evaluate(
    (rootSel) => {
      const root = document.querySelector(rootSel);
      if (!root) return [];
      return [...root.querySelectorAll("[data-recommendation-chip]")].map((el) => ({
        skillId: el.getAttribute("data-skill-id"),
        mark: el.getAttribute("data-chip-mark"),
        forced: el.getAttribute("data-forced"),
        ariaDisabled: el.getAttribute("aria-disabled"),
        buttons: [...el.querySelectorAll("button")].map((b) => ({
          action: b.getAttribute("data-skill-action"),
          disabled: b.disabled,
          pressed: b.getAttribute("aria-pressed"),
          label: (b.textContent || "").trim(),
        })),
      }));
    },
    cardRoot,
  );
  const text = rootCount > 0 ? (await page.locator(cardRoot).first().innerText()).replace(/\n{2,}/g, "\n") : "";
  // THE ROOT'S OWN DECLARATION, read off the live DOM. cinatra#2841 gave the
  // chip-row root the kind/host/state marks the capture contract identifies the
  // card by, so the record states which `data-*` attributes the root ACTUALLY
  // carries rather than asserting they are there.
  const rootAttributes = await page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return [];
    return [...root.attributes]
      .filter((a) => a.name.startsWith("data-"))
      .map((a) => (a.value ? `${a.name}="${a.value}"` : a.name));
  }, cardRoot);
  // The theme the picture was taken in, as the document reports it -- the cell
  // ASKS for a colour scheme, the document ANSWERS with the class it resolved.
  const themeClass = await page.evaluate(() => document.documentElement.className);


  const record = {
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
  };
  records.push(record);
  results.push({
    cell: cell.cell,
    requestedPath: cell.path,
    finalUrl,
    httpStatus: resp?.status() ?? null,
    rootPresent,
    rootCount,
    frameSelector: frameSel,
    pixels: dims,
    sha256,
    observed,
    colorScheme: cell.colorScheme ?? "light",
    themeClass,
    rootAttributes,
    chips,
    cardText: text.slice(0, 2000),
    pageErrors: [...pageErrors],
  });
  console.log(`CAP ${cell.cell} ${dims.width}x${dims.height} root=${rootCount} url=${finalUrl}`);
  console.log(`     TEXT ${JSON.stringify(text.slice(0, 700))}`);
  if (pageErrors.length) console.log(`     PAGEERRORS ${JSON.stringify(pageErrors)}`);
  await ctx.close();
}

fs.writeFileSync(RECORDS_OUT, JSON.stringify({ records, results }, null, 2));
await browser.close();
console.log("CAP DONE", RECORDS_OUT);
