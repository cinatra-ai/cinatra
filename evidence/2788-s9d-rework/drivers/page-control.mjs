// ---------------------------------------------------------------------------
// THE PAGE CONTROLS — C7 and C8, the two run-page stages that carry no
// lifecycle card.
//
// WHY THEY ARE NOT WALK CELLS. Every record in
// `scripts/ci/chat-hitl-capture-index.json` asserts
// `[data-lifecycle-card-host="<host>"]` on the screen it photographs
// (`requiredAssertionsFor` in `scripts/ci/lib/capture-record-contract.mjs`).
// C7 is the run's SETUP scheduling step — the shipped trigger screen — and it
// draws no lifecycle card; C8 is the run detail after the fire, where the
// schedule is a rail ROW and its surface is not drawn. Neither screen can hold
// an honest record of that index, and giving either one an anchor for the
// recorder to count would mean drawing something the plan and the drawing do
// not define. So they are filed as PAGE CONTROLS: real pictures, measured, with
// their measurements and hashes written into README.md and TIMELINE.md, and NO
// index record.
//
// MEASURED, NOT DESCRIBED — AND EXACTLY THAT MUCH. Everything this file writes
// down about a screen is counted off the live page through the recorder's own
// `playwrightPage` port — the same reader `observeCapture` measures a walk cell
// with — and every count is PAINTED-visible, not merely attached. It takes no
// assertions from its caller beyond WHICH anchors to count, and it never writes
// a verdict: the verdict is written in PLAN-WALK.md by a person who looked at
// the pixels.
//
// WHAT IT IS NOT, said plainly so nobody reads more into the sidecar than is
// there: this output does NOT pass through `observeWalkCell`, the capture-record
// contract, the index schema, or any CI gate. It is one round's sidecar, and the
// trust it carries is the trust of a measurement plus a hash — not the trust of
// an index record. The README states the same thing and leaves the filing
// question open for the maintainer.
//
// EVERY CAPTURE IS THE FULL BROWSER WINDOW: `page.screenshot()` with no clip,
// no element handle and no fullPage.
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { playwrightPage } from "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs";

const BASE = process.env.WALK_BASE;
const COOKIE = process.env.WALK_COOKIE;
const OUT_DIR = process.env.PC_OUT_DIR ?? "evidence/2788-s9d-rework/captures";
const OUT_JSON = process.env.PC_OUT_JSON;
const STAGE = process.env.PC_STAGE; // "c7" | "c8"
const URL_PATH = process.env.PC_URL; // app-relative
const WAIT_FOR = process.env.PC_WAIT; // a selector that must be painted first

for (const [name, value] of Object.entries({
  WALK_BASE: BASE, WALK_COOKIE: COOKIE, PC_OUT_JSON: OUT_JSON, PC_STAGE: STAGE, PC_URL: URL_PATH,
})) {
  if (!value) throw new Error(`page-control needs ${name} in the environment`);
}

/** The anchors each control counts. Named here, counted off the live page. */
const ANCHORS = {
  c7: [
    '[data-conformance-id="run-step-rail-column"]',
    '[data-run-detail-column]',
    'form button[type="submit"]',
    '[data-lifecycle-card-host]',
    '[data-conformance-id="agentic-run-progress"]',
  ],
  c8: [
    '[data-conformance-id="run-step-rail-column"]',
    '[data-run-detail-column]',
    '[data-conformance-id="schedule-rail-step"]',
    '[data-lifecycle-card-host]',
    '[data-conformance-id="schedule-step-detail"]',
  ],
};

const cookies = COOKIE.split("; ").map((c) => {
  const i = c.indexOf("=");
  return { name: c.slice(0, i), value: c.slice(i + 1), domain: process.env.WALK_COOKIE_DOMAIN ?? "localhost", path: "/" };
});

const browser = await chromium.launch();
const out = [];
try {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      baseURL: BASE,
    });
    await ctx.addCookies(cookies);
    await ctx.addInitScript((t) => {
      try { window.localStorage.setItem("theme", t); } catch { /* the reading below says what resolved */ }
    }, theme === "dark" ? "dark" : "cinatra");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  pageerror: ${String(e).slice(0, 200)}`));
    await page.goto(URL_PATH, { waitUntil: "domcontentloaded", timeout: 300000 });
    await page.waitForLoadState("load").catch(() => {});
    if (WAIT_FOR) await page.waitForSelector(WAIT_FOR, { timeout: 420000 });
    await page.waitForTimeout(2500);

    const reader = playwrightPage(page);
    const counts = {};
    for (const sel of ANCHORS[STAGE]) counts[sel] = await reader.countVisible(sel);

    const file = path.join(OUT_DIR, `${STAGE.toUpperCase()}__${process.env.PC_NAME}__${theme}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    const box = page.viewportSize();
    out.push({
      control: STAGE.toUpperCase(),
      theme,
      framing: "window",
      build: "development",
      screenshot: file,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      pixels: `${box.width * 2}x${box.height * 2}`,
      finalUrlPath: await reader.url(),
      resolvedTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? getComputedStyle(document.documentElement).colorScheme),
      visible: counts,
      capturedAt: new Date().toISOString(),
      record: "NONE — not a lifecycle host; filed as the page control (see README.md)",
    });
    console.log(`page control ${STAGE.toUpperCase()} ${theme} -> ${file}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
const prior = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) : [];
fs.writeFileSync(OUT_JSON, `${JSON.stringify([...prior.filter((r) => r.control !== STAGE.toUpperCase()), ...out], null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
