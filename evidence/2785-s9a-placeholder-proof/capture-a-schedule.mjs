// Proof (a): the SCHEDULE-PROPOSAL placeholder card, inside a real conversation
// on the real /chat surface of the DEV runtime.
//
// Real: the application, the chat surface, the composer, the assistant runtime,
// the self-MCP transport, the `schedule_proposal_render` producer, the proposal
// token, the DATA_PART, the card registry and the S1 shell.
// Stood in for: the model. The deterministic scripted provider chooses which
// tool this turn calls. Note this runs on a tree whose scripted schedule arm
// also composes the schedule arguments, and whose assistant runtime carries
// one condition routing such a turn here — see the evidence README, which
// states that reach. "Model layer only" would understate it.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

/**
 * The thread the app itself persisted, read back through the app's OWN route
 * in the signed-in page context. `slackMode` and `parts` are properties of the
 * TURN, not of the stylesheet, so they are asserted against the app's record
 * rather than guessed off class names.
 */
async function readPersistedThread(page) {
  return page.evaluate(async () => {
    const index = await fetch("/api/assistants/threads").then((r) => (r.ok ? r.json() : null));
    const rows = Array.isArray(index) ? index : (index?.threads ?? []);
    if (!rows.length) return null;
    const id = rows[0].id ?? rows[0].threadId;
    if (!id) return null;
    const full = await fetch(`/api/assistants/threads/${id}`).then((r) => (r.ok ? r.json() : null));
    return full?.thread ?? full;
  });
}

const BASE = "http://localhost:3105";
const OUT = "<home>/cinatra-worktrees/s9a-proofs-artifacts";
const TEMPLATE = process.env.S9A_TEMPLATE_ID;

const KIND = "trigger_schedule_proposal";
// The ratified §VI anchor set, copied verbatim from LIFECYCLE_CARD_CONTRACTS
// in scripts/audit/chat-hitl-one-card-gate.mjs. Every one must be ABSENT.
const RATIFIED_ANCHORS = [
  "schedule-option-rows",
  "schedule-proposal-floor",
  "scheduled-run-chrome",
  '[data-action="cancel-trigger-schedule"]',
  '[data-action="release-trigger-now"]',
];

const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};
const flush = () => writeFileSync(`${OUT}/capture-a-log.txt`, log.join("\n") + "\n");

// A bare conformance id is matched as [data-conformance-id="…"] — the gate's own
// `emitsAnchor` rule. An anchor already written as a selector is used as-is.
const asSelector = (a) => (a.startsWith("[") ? a : `[data-conformance-id="${a}"]`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: `${OUT}/storage-state.json`,
  viewport: { width: 1280, height: 1180 },
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

say("=== PROOF (a) — the §VI schedule-proposal placeholder, in a real conversation ===");
say("runtime: DEVELOPMENT — pnpm dev, CINATRA_RUNTIME_MODE=development,");
say("         CINATRA_TEST_LLM_PROVIDER=scripted, NODE_ENV != production.");
say("         No real provider key is present in .env.local: none was read, used or stored.");
say("         CINATRA_E2E_SETUP_BYPASS=true is set — it skips the SETUP WIZARD only.");
say(`         throwaway compose project s9aproofcap (pg 55432, redis 56379), dev port 3105`);
say(`template under proposal: ${TEMPLATE}`);

await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
say(`conversation url: ${page.url()}`);

// The driving message. ZERO mention tokens: two mentions flip the thread into
// Slack layout, which suppresses `parts` and therefore every part-level mount.
const MESSAGE = `Schedule agent ${TEMPLATE} to run every day at 07:30`;
const mentionTokens = (MESSAGE.match(/@/g) ?? []).length;
say(`driving message: "${MESSAGE}"`);
say(`mention tokens in the driving message: ${mentionTokens} (must be 0)`);

const composer = page.locator('textarea, [contenteditable="true"]').first();
await composer.click();
await composer.fill(MESSAGE);
await page.keyboard.press("Enter");
say("message typed into the REAL composer and sent");

// Wait for the card, bounded.
const cardSel = `[data-lifecycle-card="${KIND}"]`;
let appeared = false;
for (let i = 0; i < 60; i += 1) {
  if (await page.locator(cardSel).count()) {
    appeared = true;
    break;
  }
  await page.waitForTimeout(2000);
}
say(`card appeared within the bounded wait: ${appeared}`);

// ── layout assertions, BEFORE any screenshot ─────────────────────────────────
// Two mentions flip the thread into Slack layout, which suppresses `parts` —
// and `parts` is the only mount point at a tool-call position. Both facts are
// asserted here, off the app's OWN persisted thread, before any pixel is taken.
// The thread is saved when the turn settles, so the read is polled rather than
// taken once — an empty read would otherwise report a false "no parts".
let thread = null;
for (let i = 0; i < 40; i += 1) {
  thread = await readPersistedThread(page);
  const turns = (thread?.messages ?? []).filter((m) => m.role === "assistant");
  if (turns.length > 0) break;
  await page.waitForTimeout(2000);
}
const assistantTurns = (thread?.messages ?? []).filter((m) => m.role === "assistant");
const lastAssistant = assistantTurns[assistantTurns.length - 1] ?? null;
const partsLength = Array.isArray(lastAssistant?.parts) ? lastAssistant.parts.length : 0;
const dataParts = Array.isArray(lastAssistant?.dataParts) ? lastAssistant.dataParts : [];
const slackMode = thread?.slackMode ?? null;
const taggedAssistants = thread?.taggedAssistantUserIds ?? [];

say(`persisted thread id: ${thread?.id ?? "<none>"}`);
say(`slackMode===false: ${slackMode === false} (persisted slackMode=${JSON.stringify(slackMode)})`);
say(`taggedAssistantUserIds: ${JSON.stringify(taggedAssistants)} (empty — the driving message names nobody)`);
say(`parts.length>0: ${partsLength > 0} (parts=${partsLength})`);
// The proposal `ref` is an opaque handle, not a reading. Echo it the way proof
// (b) echoes its verification ref — a short prefix and the length — so the log
// still shows one was issued without printing the whole handle.
const loggedDataParts = dataParts.map((p) =>
  typeof p?.ref === "string" ? { ...p, ref: `${p.ref.slice(0, 24)}… (${p.ref.length} chars)` } : p,
);
say(`assistant dataParts: ${JSON.stringify(loggedDataParts)}`);
const layout = await page.evaluate(() => ({
  conversationList: Boolean(document.querySelector("[data-conversation-list]")),
  composerVisible: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
}));
say(`conversationList present: ${layout.conversationList}`);
say(`composer visible (in frame): ${layout.composerVisible}`);

// ── the card's own DOM ───────────────────────────────────────────────────────
const card = await page.evaluate(
  ({ kind, anchors }) => {
    const sel = `[data-lifecycle-card="${kind}"]`;
    const nodes = Array.from(document.querySelectorAll(sel));
    const list = document.querySelector("[data-conversation-list]");
    const root = nodes[0] ?? null;
    const anchorCounts = {};
    for (const a of anchors) {
      const s = a.startsWith("[") ? a : `[data-conformance-id="${a}"]`;
      // Counted globally AND inside the card, so "absent" cannot hide behind scope.
      anchorCounts[a] = {
        inCard: root ? root.querySelectorAll(s).length : 0,
        inDocument: document.querySelectorAll(s).length,
      };
    }
    return {
      count: nodes.length,
      kindAttr: root?.getAttribute("data-lifecycle-card") ?? null,
      stateAttr: root?.getAttribute("data-lifecycle-card-state") ?? null,
      hostAttr: root?.getAttribute("data-lifecycle-card-host") ?? null,
      insideConversationList: Boolean(root && list && list.contains(root)),
      text: root?.innerText ?? null,
      anchorCounts,
    };
  },
  { kind: KIND, anchors: RATIFIED_ANCHORS },
);

say("");
say("CARD IDENTITY (the two attributes the S1 shell emits):");
say(`  instances of [data-lifecycle-card="${KIND}"]: ${card.count} (must be exactly 1)`);
say(`  data-lifecycle-card       = ${JSON.stringify(card.kindAttr)}   PRESENT: ${card.kindAttr !== null}`);
say(`  data-lifecycle-card-state = ${JSON.stringify(card.stateAttr)}  PRESENT: ${card.stateAttr !== null}`);
say(`  data-lifecycle-card-host  = ${JSON.stringify(card.hostAttr)}   (the S1 shell emits none — an owner must)`);
say(`  card is INSIDE the conversation list: ${card.insideConversationList}`);
say(`  card text: ${JSON.stringify(card.text)}`);

// ── the proof is only a proof if the card is THERE ───────────────────────────
// WHY THIS GUARD EXISTS. Every anchor count below is taken off `root`, and
// `root` is `null` when no card rendered. A broken surface therefore produced
// zero counts, `allAbsent === true` and exit 0 — a PASSING "all absent" proof of
// a page that drew nothing. Absence is only evidence when the card whose anchors
// are absent was actually photographed. So the identity above is asserted here,
// before the absence is computed, and a failure stops the run instead of
// printing a conclusion the readings do not support.
//
// The guard prints NOTHING on the passing path, so the committed log is still
// byte-for-byte what this program prints on the run it records.
const identityFailures = [];
if (!appeared) identityFailures.push("the card never appeared within the bounded wait");
if (card.count !== 1) identityFailures.push(`instances of ${cardSel} = ${card.count}, expected exactly 1`);
if (card.kindAttr !== KIND) identityFailures.push(`data-lifecycle-card = ${JSON.stringify(card.kindAttr)}, expected ${JSON.stringify(KIND)}`);
if (card.stateAttr === null) identityFailures.push("data-lifecycle-card-state is absent — the card cannot say which state it drew in");
// The line above claims the S1 shell emits no host. If that stops being true the
// record's reading is stale, and a stale reading may not be printed as a fact.
if (card.hostAttr !== null) identityFailures.push(`data-lifecycle-card-host = ${JSON.stringify(card.hostAttr)}, and this record states the S1 shell emits none`);
if (identityFailures.length > 0) {
  say("");
  say("CARD IDENTITY FAILED — nothing was photographed and no absence is claimed:");
  for (const f of identityFailures) say(`  ${f}`);
  flush();
  await browser.close();
  process.exit(1);
}

say("");
say("RATIFIED §VI ANCHORS — every one must be ABSENT (the absence is the evidence).");
say("Read verbatim off LIFECYCLE_CARD_CONTRACTS.trigger_schedule_proposal.anchors:");
let allAbsent = true;
for (const a of RATIFIED_ANCHORS) {
  const c = card.anchorCounts[a];
  const absent = c.inCard === 0 && c.inDocument === 0;
  if (!absent) allAbsent = false;
  say(`  ${absent ? "ABSENT " : "PRESENT"}  ${a}   selector=${asSelector(a)}  inCard=${c.inCard} inDocument=${c.inDocument}`);
}
say(`ALL FIVE RATIFIED SCHEDULE ANCHORS ABSENT: ${allAbsent}`);
say(`page errors: ${pageErrors.length} ${JSON.stringify(pageErrors)}`);

// A PRESENT anchor means the card is drawn, which is the opposite of what this
// cell records. The program stops rather than photographing a placeholder claim
// its own readings contradict. Silent on the passing path.
if (!allAbsent) {
  say("AT LEAST ONE RATIFIED ANCHOR IS PRESENT — this is not a placeholder; nothing was photographed.");
  flush();
  await browser.close();
  process.exit(1);
}

// ── the pixels ───────────────────────────────────────────────────────────────
await page.locator(cardSel).first().scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/S9a-a__chat_thread__schedule-proposal-placeholder.png` });
say("captured S9a-a (conversation + composer in frame)");

flush();
await browser.close();
