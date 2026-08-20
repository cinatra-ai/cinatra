// ---------------------------------------------------------------------------
// cinatra#2853 — the TYPED DECISIONS capture.
//
// Four cells, four threads, one card each. Every one of them is driven the same
// way and the ONLY difference between them is the sentence typed into the chat
// composer, which is exactly the variable under proof.
//
// WHY ONE CARD PER THREAD. `resolveComposerTarget` binds the composer to a card
// implicitly only when exactly one is eligible; with two on screen every typed
// message becomes a `refuse-ambiguous` refusal, which is a different cell from
// these four. Each gate therefore has a thread of its own.
//
// NOTHING IS PRESSED. No Approve button, no Reject button, no Comment button is
// clicked anywhere in this file. A decision here happens because a person typed
// a sentence and pressed Enter in the prompt window, which is the whole slice.
//
// WHAT IS RECORDED beside every picture: the anchors the card published, the
// card's state attribute BEFORE and AFTER the message, the assistant's ack line
// as it landed in the transcript, and the gate's own row status read back from
// the database. A picture of a card that says "approved" is worth much less
// than a picture plus the row that agrees with it.
//
// Usage: node 04-capture-typed.mjs <outDir> <repoRoot>
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const OUT = process.argv[2];
const REPO_ROOT = process.argv[3];
const SHOT_DIR_REL = "evidence/2853-typed-decisions/captures";
const BASE = process.env.CAP_BASE;
const PLAN = JSON.parse(readFileSync(process.env.CAP_PLAN, "utf8"));
const THREADS = JSON.parse(readFileSync(process.env.CAP_THREADS, "utf8"));
const WALK = JSON.parse(readFileSync(process.env.WALK_STATE_FILE, "utf8"));
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

const COLUMN = "[data-conversation-list]";
const CARD_ROOT = '[data-conformance-id="review-gate-card"]';
const COMPOSER = '[role="textbox"][contenteditable="true"]';

const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
async function gateRow(slot) {
  const r = await db.query(
    `SELECT status FROM ${SCHEMA}.artifact_review_gates WHERE id = $1`,
    [WALK[`gateId_${slot}`]],
  );
  return r.rows[0]?.status ?? null;
}
/**
 * WHAT THE SERVER RECORDED, read back from the shipped rows rather than from the
 * sentence on screen.
 *
 *  - `artifact_review_gates` carries the OUTCOME and the DECIDER
 *    (`disposition`, `resolved_by`) — the merged #2862 reading.
 *  - the RATIONALE is not on that row: it travels in the shipped resume
 *    envelope, `artifact_review_resume_outbox.response_text`, as the envelope's
 *    own `comment`. This function reads exactly that field and nothing around
 *    it, so the record shows where the note actually lives.
 */
async function recordedDecision(slot) {
  const gateId = WALK[`gateId_${slot}`];
  const g = await db.query(
    `SELECT status, disposition, resolved_by FROM ${SCHEMA}.artifact_review_gates WHERE id = $1`,
    [gateId],
  );
  const o = await db.query(
    `SELECT kind, response_text FROM ${SCHEMA}.artifact_review_resume_outbox
      WHERE gate_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [gateId],
  ).catch(() => ({ rows: [] }));
  let envelopeComment = null;
  let envelopeDecision = null;
  try {
    const env = JSON.parse(o.rows[0]?.response_text ?? "null")?.review;
    envelopeComment = env?.comment ?? null;
    envelopeDecision = env?.decision ?? null;
  } catch {}
  return {
    gateStatus: g.rows[0]?.status ?? null,
    gateDisposition: g.rows[0]?.disposition ?? null,
    resolvedByUserId: g.rows[0]?.resolved_by ? "<a user id, present>" : null,
    resumeEnvelopeKind: o.rows[0]?.kind ?? null,
    resumeEnvelopeDecision: envelopeDecision,
    resumeEnvelopeComment: envelopeComment,
  };
}

const browser = await chromium.launch({ headless: true });

// --- counting rules ---------------------------------------------------------
//   frame — document.querySelectorAll(sel).length on the page's own document
//           (there is one document here; no widget frame is involved).
//   root  — the card root's OWN subtree INCLUDING the root element itself, so a
//           marker carried ON the root is not reported as absent.
const ASSERTIONS = [
  { selector: COLUMN, scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: '[data-lifecycle-card="artifact_review_gate"]', scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "root" },
  { selector: '[data-conformance-id="review-gate-settled"]', scope: "root" },
  { selector: '[data-conformance-id="review-composer-bound"]', scope: "root" },
];

const records = [];
const results = [];

for (const cell of PLAN.cells) {
  const thread = THREADS.find((t) => t.slot === cell.slot);
  const ctx = await browser.newContext({
    viewport: { width: 1228, height: 1400 },
    deviceScaleFactor: 2,
  });
  await ctx.addCookies(
    cell.cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: c.slice(i + 1), domain: "localhost", path: "/" };
    }),
  );
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  const stripDevOverlay = async () => {
    await page
      .evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()))
      .catch(() => {});
  };

  say(`\n=== ${cell.cell} — ${cell.reader} types ${JSON.stringify(cell.message)} ===`);
  await page.goto(BASE + thread.path, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.locator(CARD_ROOT).first().waitFor({ state: "attached", timeout: 300_000 });
  // The island is a nested frame; let it answer so the card is photographed
  // whole rather than mid-load.
  await page.waitForTimeout(cell.settleMs ?? 9000);
  await stripDevOverlay();

  const stateBefore = await page
    .locator(CARD_ROOT)
    .first()
    .getAttribute("data-lifecycle-card-state");
  const gateBefore = await gateRow(cell.slot);
  const boundBefore = await page
    .locator('[data-conformance-id="review-composer-focus"]')
    .first()
    .getAttribute("data-composer-bound")
    .catch(() => null);
  say(`BEFORE card-state=${stateBefore} gate-row=${gateBefore} composer-bound=${boundBefore}`);

  // OPTIONALLY GIVE THE BINDING BACK. A lone open review binds the composer with
  // no press at all, and the card's own control gives it back in one press
  // ("Reply from the chat box"). A cell that wants an ORDINARY chat message has
  // to press it — otherwise the message is the card's comment, which is a
  // different thing entirely.
  let boundAfterRelease = boundBefore;
  if (cell.releaseComposer) {
    await page.locator('[data-action="focus-review-composer"]').first().click();
    await page.waitForTimeout(1500);
    boundAfterRelease = await page
      .locator('[data-conformance-id="review-composer-focus"]')
      .first()
      .getAttribute("data-composer-bound")
      .catch(() => null);
    say(`pressed the card's own composer control; composer-bound is now ${boundAfterRelease}`);
    if (boundAfterRelease !== "false") throw new Error("the composer did not release");
  }

  // --- the ONE act of this round: type the sentence, press Enter ----------
  const composer = page.locator(COMPOSER).first();
  await composer.waitFor({ state: "visible", timeout: 120_000 });
  await composer.click();
  await composer.type(cell.message, { delay: 15 });
  await stripDevOverlay();
  await composer.press("Enter");
  say(`typed and sent: ${JSON.stringify(cell.message)}  (no control was pressed)`);

  // Wait for the transcript to grow by the assistant's ack, or for the card to
  // settle — whichever this cell expects. Never a bare sleep as the only wait.
  // WAIT FOR THE ANSWER, never for a clock alone. `expectAck` is the substring
  // the transcript must actually carry before the picture is taken — an ack that
  // has not landed yet reads on screen as "Thinking", and a capture taken then
  // would photograph the wait rather than the answer.
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(1000);
    const st = await page
      .locator(CARD_ROOT)
      .first()
      .getAttribute("data-lifecycle-card-state")
      .catch(() => null);
    const text = await page.locator(COLUMN).first().innerText().catch(() => "");
    const settledOk = cell.expectSettled ? st === "settled" : true;
    const ackOk = cell.expectAck ? text.includes(cell.expectAck) : i >= 8;
    const typedEchoed = text.includes(cell.message);
    if (settledOk && ackOk && typedEchoed) {
      say(`answer landed after ~${i + 1}s`);
      break;
    }
  }
  await page.waitForTimeout(cell.postMs ?? 4000);
  await stripDevOverlay();

  const stateAfter = await page
    .locator(CARD_ROOT)
    .first()
    .getAttribute("data-lifecycle-card-state")
    .catch(() => null);
  const gateAfter = await gateRow(cell.slot);
  const recorded = await recordedDecision(cell.slot);
  const columnText = (await page.locator(COLUMN).first().innerText().catch(() => "")).replace(
    /\n{2,}/g,
    "\n",
  );
  say(`AFTER  card-state=${stateAfter} gate-row=${gateAfter} recorded=${JSON.stringify(recorded)}`);
  say(`TRANSCRIPT TAIL:\n${columnText.slice(-900)}`);

  // --- the picture: the COLUMN, which is where a typed decision happens ----
  const rel = `${SHOT_DIR_REL}/${cell.cell}.png`;
  const abs = join(REPO_ROOT, rel);
  await page.locator(COLUMN).first().screenshot({ path: abs, scale: "device" });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };

  const observed = [];
  for (const { selector, scope } of ASSERTIONS) {
    const count =
      scope === "frame"
        ? await page.evaluate((s) => document.querySelectorAll(s).length, selector)
        : await page.evaluate(
            ({ s, rootSel }) => {
              const root = document.querySelector(rootSel);
              if (!root) return 0;
              return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
            },
            { s: selector, rootSel: CARD_ROOT },
          );
    observed.push({ selector, scope, count });
  }

  records.push({
    cell: cell.cell,
    declaredHost: "chat_thread",
    declaredKind: "artifact_review_gate",
    declaredState: cell.declaredState,
    finalUrl: new URL(page.url()).pathname,
    screenshot: rel,
    sha256,
    assertions: observed,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: process.env.CAP_RUNTIME_NOTE ?? "",
    note: cell.note,
    typed: {
      reader: cell.reader,
      message: cell.message,
      controlPressed: cell.releaseComposer
        ? "only the card's own \"Reply from the chat box\" control, to GIVE BACK the implicit binding before typing; no decision control was pressed"
        : "none — the message was typed into the chat composer and sent with Enter",
      composerBoundBefore: boundBefore,
      composerBoundWhenSent: boundAfterRelease,
    },
    observedTransition: {
      cardStateBefore: stateBefore,
      cardStateAfter: stateAfter,
      gateRowBefore: gateBefore,
      gateRowAfter: gateAfter,
      recorded,
    },
  });
  results.push({
    cell: cell.cell,
    pixels: dims,
    sha256,
    observed,
    columnText: columnText.slice(-2000),
    pageErrors: [...pageErrors],
  });
  say(`CAP ${cell.cell} ${dims.width}x${dims.height} pageErrors=${pageErrors.length}`);
  await ctx.close();
}

await db.end();
writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results }, null, 2));
writeFileSync(join(OUT, "capture.txt"), log.join("\n") + "\n");
await browser.close();
console.log("CAPTURE OK");
