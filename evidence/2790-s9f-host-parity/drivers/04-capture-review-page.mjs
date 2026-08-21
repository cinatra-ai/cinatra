// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the RECOMMENDATION CARD on the RUN REVIEW PAGE
// (`page_gate_region`), ABOVE the review gate card.
//
// A cookie surface: the page declares `host="page_gate_region"` with NO
// credential, so the card resolves through the shipped server action, exactly
// as it does on the run page. Nothing here is stood in for on the read side.
//
// WHAT IS RECORDED BESIDE EVERY PICTURE: the anchors, counted in the document
// the picture was taken in, plus the ORDER of the two cards inside the gate
// region — which is the §6.4 claim this mount makes ("ahead of the steps it
// would authorize ... and on the review page").
//
// No origin is hard-coded: the app origin is read from the environment.
//
// Usage: node 04-capture-review-page.mjs <appOrigin> <reviewPath> <outDir> <repoRoot>
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2];
const REVIEW_PATH = process.argv[3];
const OUT = process.argv[4];
const REPO_ROOT = process.argv[5];
const SHOT_DIR_REL = "evidence/2790-s9f-host-parity/captures";
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
if (!APP || !REVIEW_PATH || !OUT || !REPO_ROOT || !ACTOR.email || !ACTOR.password) {
  throw new Error("usage: 04-capture-review-page.mjs <appOrigin> <reviewPath> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW");
}

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const GATE_ROOT = '[data-lifecycle-card="artifact_review_gate"]';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

const stripDevOverlay = async () => {
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
};

// --- counting rules ---------------------------------------------------------
//   frame — document.querySelectorAll(sel).length on THIS document (the review
//           page; there is no nested frame in these cells).
//   root  — the card root's OWN subtree INCLUDING the root element.
async function counts(selectors) {
  const out = [];
  for (const { selector, scope } of selectors) {
    let count = 0;
    if (scope === "frame") {
      count = await page.evaluate((s) => document.querySelectorAll(s).length, selector);
    } else {
      count = await page
        .evaluate(
          ({ s, rootSel }) => {
            const root = document.querySelector(rootSel);
            if (!root) return 0;
            return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
          },
          { s: selector, rootSel: CARD_ROOT },
        )
        .catch(() => 0);
    }
    out.push({ selector, scope, count });
  }
  return out;
}

const ASSERTIONS = [
  { selector: '[data-lifecycle-card-host="page_gate_region"]', scope: "frame" },
  { selector: '[data-lifecycle-card="recommendation_hold"]', scope: "frame" },
  { selector: '[data-lifecycle-card="artifact_review_gate"]', scope: "frame" },
  { selector: '[data-conformance-id="review-gate-card"]', scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: "[data-recommendation-chip]", scope: "root" },
  { selector: '[data-conformance-id="run-chip-row"]', scope: "frame" },
];

async function rootAttributes() {
  return page
    .evaluate((rootSel) => {
      const el = document.querySelector(rootSel);
      if (!el) return null;
      const out = {};
      for (const a of el.attributes) out[a.name] = a.value;
      delete out.class;
      return out;
    }, CARD_ROOT)
    .catch(() => null);
}

async function chipReadout() {
  return page
    .evaluate((rootSel) => {
      const root = document.querySelector(rootSel);
      if (!root) return [];
      return [...root.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
        skillId: c.getAttribute("data-skill-id"),
        mark: c.getAttribute("data-chip-mark"),
        forced: c.hasAttribute("data-forced"),
        label: (c.querySelector("span")?.textContent ?? "").trim(),
        actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
      }));
    }, CARD_ROOT)
    .catch(() => []);
}

/** The ORDER claim, measured: is the recommendation card ABOVE the gate card? */
async function orderReadout() {
  return page
    .evaluate(
      ({ cardSel, gateSel }) => {
        const card = document.querySelector(cardSel);
        const gate = document.querySelector(gateSel);
        if (!card || !gate) return { card: Boolean(card), gate: Boolean(gate), cardAboveGate: null };
        const c = card.getBoundingClientRect();
        const g = gate.getBoundingClientRect();
        return {
          card: true,
          gate: true,
          cardTop: Math.round(c.top + window.scrollY),
          gateTop: Math.round(g.top + window.scrollY),
          cardAboveGate: c.top + window.scrollY < g.top + window.scrollY,
          domOrder: card.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING ? "card-then-gate" : "gate-then-card",
        };
      },
      { cardSel: CARD_ROOT, gateSel: GATE_ROOT },
    )
    .catch(() => null);
}

const records = [];
const results = [];
/** The one clip rectangle every paired card-root cell shares. */
let sharedClip = null;

async function shoot(cell, declaredState, note, framing = "card-root", extra = {}) {
  await stripDevOverlay();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  if (framing === "card-root") {
    // THE PAIRED CELLS SHARE ONE CLIP RECTANGLE. Shooting the locator twice gave
    // the light and the dark cell widths that differed by 2 CSS px (a scrollbar
    // difference), which is not "identical framing". So the LIGHT pass measures
    // the card's box once and both cells are clipped to that same rectangle.
    if (!sharedClip) {
      sharedClip = await page.locator(CARD_ROOT).first().boundingBox();
      if (!sharedClip) throw new Error("the card root has no box to clip to");
      sharedClip = {
        x: Math.round(sharedClip.x),
        y: Math.round(sharedClip.y),
        width: Math.round(sharedClip.width),
        height: Math.round(sharedClip.height),
      };
      say(`SHARED CLIP ${JSON.stringify(sharedClip)}`);
    }
    await page.screenshot({ path: abs, clip: sharedClip, scale: "device" });
  } else {
    await page.screenshot({ path: abs, fullPage: true, scale: "device" });
  }
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const observed = await counts(ASSERTIONS);
  const attrs = await rootAttributes();
  const chips = await chipReadout();
  const order = await orderReadout();
  const theme = await page.evaluate(() => document.documentElement.className).catch(() => "");
  const cardText = await page
    .locator(CARD_ROOT)
    .first()
    .innerText()
    .then((t) => t.replace(/\n{2,}/g, "\n"))
    .catch(() => "");
  records.push({
    cell,
    declaredHost: "page_gate_region",
    declaredKind: "recommendation_hold",
    declaredState,
    finalUrl: new URL(page.url()).pathname,
    screenshot: rel,
    sha256,
    assertions: observed,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: process.env.S9F_RUNTIME_NOTE ?? "",
    note,
    rootAttributes: attrs,
    chips,
    order,
    themeClass: theme,
    framing,
    clip: framing === "card-root" ? sharedClip : null,
    pageErrors: [...pageErrors],
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, order, themeClass: theme, framing, cardText: cardText.slice(0, 2000) });
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} order=${JSON.stringify(order)} theme="${theme}"`);
  return dims;
}

/** Apply the palette next-themes applies, through the shipped control when the
 *  page draws one; otherwise by writing the SAME class the control writes. */
async function setTheme(name) {
  const applied = await page.evaluate((t) => {
    const el = document.documentElement;
    el.classList.remove("cinatra", "dark");
    el.classList.add(t);
    el.style.colorScheme = t === "dark" ? "dark" : "light";
    return el.className;
  }, name);
  await page.waitForTimeout(900);
  return applied;
}

try {
  say(`# cinatra#2790 S9f review-page capture — ${new Date().toISOString()}`);
  await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForTimeout(2500);
  if (new URL(page.url()).pathname.startsWith("/sign-in")) {
    await page.locator('input[type="email"], input[name="email"]').first().fill(ACTOR.email);
    await page.locator('input[type="password"], input[name="password"]').first().fill(ACTOR.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(6000);
  }
  say(`after sign-in: ${new URL(page.url()).pathname}`);

  await page.goto(`${APP}${REVIEW_PATH}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  say(`review page: ${new URL(page.url()).pathname}`);
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(2000);
    const present = await page.evaluate((s) => Boolean(document.querySelector(s)), CARD_ROOT).catch(() => false);
    if (present) {
      say(`recommendation card appeared after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(3000);
  say(`CHIPS ${JSON.stringify(await chipReadout())}`);
  say(`ORDER ${JSON.stringify(await orderReadout())}`);

  await setTheme("cinatra");
  await shoot(
    "R1__recommendation-card__page_gate_region__held",
    "pending",
    "The recommendation card HELD on the run review page, framed on the card root. One chip per skill, each carrying its own Confirm / Adjust / Skip and printing the owning extension's manifest displayName. The host declaration on the region root is what makes this a page_gate_region mount, per the anchor contract.",
    "card-root",
  );

  await shoot(
    "R2__recommendation-card__page_gate_region__held__above-gate",
    "pending",
    "The SAME held card IN ITS PAGE, uncropped and full-length, with the REVIEW GATE CARD beneath it — the ordering plan section 6.4 asks for: the run-start decision above the after-the-fact one, so reading down the gate region is reading the run in order. The measured order is carried in this record's `order`.",
    "page",
  );

  await setTheme("dark");
  await shoot(
    "R3__recommendation-card__page_gate_region__held__dark",
    "pending",
    "The SAME held card, same run, same framing selector, in the dark palette — the class next-themes writes when the shipped theme control is pressed. Nothing else changed.",
    "card-root",
  );
  await setTheme("cinatra");

  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, pageErrors }, null, 2));
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  say(`pageErrors: ${JSON.stringify(pageErrors)}`);
  say("CAPTURE OK");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, pageErrors }, null, 2));
} finally {
  writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
  await browser.close();
}
