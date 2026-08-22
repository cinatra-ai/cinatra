// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the RECOMMENDATION ROW on the RUN REVIEW PAGE
// (`page_gate_region`), IN ITS DECIDED FORM, ABOVE the review gate card.
//
// WHY DECIDED AND NOT HELD. The skills recommendation is the decision taken
// BEFORE the agent starts; the review page is a surface that exists only AFTER
// the run produced something. So a HELD, still-pressable recommendation on the
// review page is a state no real flow can put there — it can only be staged.
// The plan says the same in one sentence (§6.4 item 6): the row appears "on the
// review page, where it is mostly seen in its decided form".
//
// So this recorder photographs the state the REAL sequence leaves behind. Its
// input is a run that `05-run-page-real-sequence.mjs` already walked: started
// person-present, decided chip by chip through the card's own controls on the
// run page, then driven onward through its own input and its trigger form. This
// recorder only READS.
//
// WHAT IS RECORDED BESIDE EVERY PICTURE: the anchors, counted in the document
// the picture was taken in; the settled per-chip read-out; the ABSENCE of every
// decision affordance inside the card root; and the ORDER of the two cards
// inside the gate region — the §6.4 claim this mount makes.
//
// THE GATE CARD RESOLVES ASYNCHRONOUSLY. It is a client card that fetches its
// own view (`POST /api/lifecycle-views/resolve`), so this recorder WAITS for it
// rather than sampling once: a cell shot before it lands would show a decided
// row over an empty region and quietly under-state the page.
//
// SO DOES ITS REVIEW TARGET, AND FOR LONGER. The gate card's target panel is a
// LAZY `<iframe>` (`/lifecycle/review-island`) that paints its own placeholder
// bars until it resolves — measured on this lane at roughly forty seconds,
// where the gate card itself lands in under twenty. Shooting on the gate card
// alone therefore photographs a page whose target is still a row of grey bars,
// which reads as "the run produced nothing". So this recorder ALSO waits for
// the island frame to carry the target's own text, and says in the log how long
// that took. It never fabricates the wait: if the island does not resolve, the
// cells still shoot and the record carries `reviewTargetResolved: false`.
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
/** The lifecycle wire, presence + status only — never a body, never a value. */
const wire = [];
page.on("response", (res) => {
  const path = new URL(res.url()).pathname;
  if (path.startsWith("/api/lifecycle-views/")) wire.push({ method: res.request().method(), path, status: res.status() });
});

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
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "frame" },
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
        text: c.textContent.trim(),
        actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
      }));
    }, CARD_ROOT)
    .catch(() => []);
}

/** The ORDER claim, measured: is the recommendation row ABOVE the gate card? */
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

/** What the gate card underneath is asking for, read off its own decision bar. */
async function gateReadout() {
  return page
    .evaluate((gateSel) => {
      const gate = document.querySelector(gateSel);
      if (!gate) return null;
      const bar = document.querySelector('[data-conformance-id="review-decision-bar"]');
      return {
        state: gate.getAttribute("data-lifecycle-card-state"),
        host: gate.getAttribute("data-lifecycle-card-host"),
        decisionBar: Boolean(bar),
        decisionButtons: bar ? [...bar.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean) : [],
      };
    }, GATE_ROOT)
    .catch(() => null);
}

const records = [];
const results = [];
/** The gate card's own review-target island reading, filled in below. */
let reviewTarget = "";
let reviewTargetResolved = false;
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
  const gate = await gateReadout();
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
    gate,
    themeClass: theme,
    framing,
    reviewTargetResolved,
    reviewTarget: reviewTarget.slice(0, 800),
    clip: framing === "card-root" ? sharedClip : null,
    pageErrors: [...pageErrors],
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, order, gate, themeClass: theme, framing, reviewTargetResolved, reviewTarget: reviewTarget.slice(0, 800), cardText: cardText.slice(0, 2000) });
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} order=${JSON.stringify(order)} gate=${JSON.stringify(gate)} theme="${theme}"`);
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

/** Sign in through the app's OWN hosted form, retried against hydration races. */
async function signIn() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector('input[name="email"]', { timeout: 300_000 });
    await page.waitForTimeout(4000);
    const em = page.locator('input[name="email"]').first();
    const pw = page.locator('input[name="password"]').first();
    await em.click();
    await em.pressSequentially(ACTOR.email, { delay: 12 });
    await pw.click();
    await pw.pressSequentially(ACTOR.password, { delay: 6 });
    if ((await em.inputValue()) !== ACTOR.email) continue;
    await page.locator('button[type="submit"]').first().click();
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(2000);
      if (!new URL(page.url()).pathname.startsWith("/sign-in")) return new URL(page.url()).pathname;
    }
  }
  throw new Error("sign-in did not leave /sign-in");
}

try {
  say(`# cinatra#2790 S9f review-page capture (DECIDED form) — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);

  await page.goto(`${APP}${REVIEW_PATH}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  say(`review page: ${new URL(page.url()).pathname}`);
  // BOTH cards, not just the first: the row is server-rendered and the gate card
  // resolves over the wire, so waiting on the row alone would shoot too early.
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(2000);
    const seen = await page
      .evaluate(({ c, g }) => ({ card: Boolean(document.querySelector(c)), gate: Boolean(document.querySelector(g)) }), { c: CARD_ROOT, g: GATE_ROOT })
      .catch(() => ({ card: false, gate: false }));
    if (seen.card && seen.gate) {
      ready = true;
      say(`both cards present after ~${(i + 1) * 2}s`);
      break;
    }
  }
  if (!ready) throw new Error("the gate region did not draw both cards");
  await page.waitForTimeout(3000);

  // Wait for the gate card's own review-target island to resolve. Its text is
  // read from the island FRAME, never asserted from the host document.
  const islandText = async () => {
    for (const f of page.frames()) {
      if (f.url().includes("/lifecycle/review-island")) {
        const t = await f.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n")).catch(() => "");
        if (t.trim().length > 0) return t;
      }
    }
    return "";
  };
  let islandWaitedMs = 0;
  for (let i = 0; i < 60; i += 1) {
    reviewTarget = await islandText();
    if (reviewTarget.trim().length > 0) break;
    await page.waitForTimeout(3000);
    islandWaitedMs += 3000;
  }
  reviewTargetResolved = reviewTarget.trim().length > 0;
  say(`REVIEW TARGET resolved=${reviewTargetResolved} after ~${Math.round(islandWaitedMs / 1000)}s`);
  say(`REVIEW TARGET TEXT ${JSON.stringify(reviewTarget.slice(0, 800))}`);
  // Settle the frame's paint before the first shot.
  await page.waitForTimeout(4000);

  const settled = await chipReadout();
  say(`CHIPS ${JSON.stringify(settled)}`);
  say(`ORDER ${JSON.stringify(await orderReadout())}`);
  say(`GATE ${JSON.stringify(await gateReadout())}`);
  const affordances = await counts([
    { selector: '[data-skill-action="confirm"]', scope: "root" },
    { selector: '[data-skill-action="adjust"]', scope: "root" },
    { selector: '[data-skill-action="skip"]', scope: "root" },
  ]);
  say(`AFFORDANCES ${JSON.stringify(affordances)}`);
  // FAIL RATHER THAN PHOTOGRAPH A HELD ROW. This recorder exists because the
  // held reading is unreachable here; if it ever appears, that is the finding,
  // not the cell.
  const state = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
  if (state !== "decided") throw new Error(`the row is "${state}", not "decided" — nothing here is staged into the decided form`);
  if (affordances.some((a) => a.count !== 0)) throw new Error("a decided row still carries a decision affordance");

  await setTheme("cinatra");
  await shoot(
    "R1__recommendation-card__page_gate_region__decided",
    "decided",
    "The recommendation row on the run review page in its DECIDED form, framed on the card root. One settled chip per kept skill, each printing the owning extension's manifest displayName and its own outcome — Confirmed / Adjusted — and NOTHING to press. This is the record of what was chosen before the run started; the decision itself was taken on the run page through the card's own per-chip controls (see logs/real-sequence.log), never here.",
    "card-root",
  );

  await shoot(
    "R2__recommendation-card__page_gate_region__decided__above-gate",
    "decided",
    "The SAME decided row IN ITS PAGE, uncropped and full-length, with the REVIEW GATE CARD beneath it still AWAITING its decision (Comment / Reject / Approve). This is the ordering plan section 6.4 asks for, in the only composition a real flow produces: the run-start decision settled above the after-the-fact one that is still open. The measured order is carried in this record's `order`, the gate's own reading in `gate`.",
    "page",
  );

  await setTheme("dark");
  await shoot(
    "R3__recommendation-card__page_gate_region__decided__dark",
    "decided",
    "The SAME decided row, same run, same clip rectangle, in the dark palette — the class next-themes writes when the shipped theme control is pressed. Nothing else changed.",
    "card-root",
  );

  await shoot(
    "R4__recommendation-card__page_gate_region__decided__above-gate__dark",
    "decided",
    "The SAME page framing as R2, same run, in the dark palette: the decided row above the still-open review gate card.",
    "page",
  );
  await setTheme("cinatra");

  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, pageErrors }, null, 2));
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  say(`WIRE ${JSON.stringify(wire)}`);
  say(`pageErrors: ${JSON.stringify(pageErrors)}`);
  say("CAPTURE OK");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, pageErrors }, null, 2));
} finally {
  writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
  await browser.close();
}
