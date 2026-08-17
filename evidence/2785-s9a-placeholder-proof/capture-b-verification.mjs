// Proof (b): the VERIFICATION placeholder card, inside a real conversation on
// the real /chat surface of the DEV runtime, reached through the EXISTING seed
// path (`POST /api/development/lifecycle-seed`, fixture `repairVerification`).
//
// Real: the application, the chat surface, the composer, the assistant runtime,
// the self-MCP transport, the `verification_record_render` producer, the review
// gate, the repair, the verification record, the DATA_PART, the card registry
// and the S1 shell.
// Stood in for: the model. The deterministic scripted provider chooses which
// tool this turn calls. Note this runs on a tree whose scripted schedule arm
// also composes the schedule arguments, and whose assistant runtime carries
// one condition routing such a turn here — see the evidence README, which
// states that reach. "Model layer only" would understate it.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:3105";
const OUT = "/Users/marcushorndt/cinatra-worktrees/s9a-proofs-artifacts";
const SEED_TOKEN = readFileSync(`${OUT}/.seed-token`, "utf8").trim();
const ORG = "7bddfe3f-4d00-4f8c-858a-42931e662627";
const ACTOR = "a0e562f7-fae5-4a5f-ae2a-669835336c4f";
const RUN_START_PATH = "/agents/cinatra-ai/planner-agent/new";

const KIND = "verification_summary";
// The ratified §VII anchor set, copied verbatim from LIFECYCLE_CARD_CONTRACTS
// in scripts/audit/chat-hitl-one-card-gate.mjs: the base anchor, plus every
// member of the ratified one-of outcome group. Every one must be ABSENT.
const RATIFIED_ANCHORS = [
  "verification-in-thread",
  "verification-verified",
  "verification-drift",
  "verification-findings-not-met",
];

const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};
const flush = () => writeFileSync(`${OUT}/capture-b-log.txt`, log.join("\n") + "\n");
const asSelector = (a) => (a.startsWith("[") ? a : `[data-conformance-id="${a}"]`);

async function readPersistedThread(page, threadId) {
  return page.evaluate(async (id) => {
    if (id) {
      const one = await fetch(`/api/assistants/threads/${id}`).then((r) => (r.ok ? r.json() : null));
      return one?.thread ?? one;
    }
    const index = await fetch("/api/assistants/threads").then((r) => (r.ok ? r.json() : null));
    const rows = Array.isArray(index) ? index : (index?.threads ?? []);
    if (!rows.length) return null;
    const first = rows[0].id ?? rows[0].threadId;
    const full = await fetch(`/api/assistants/threads/${first}`).then((r) => (r.ok ? r.json() : null));
    return full?.thread ?? full;
  }, threadId);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: `${OUT}/storage-state.json`,
  viewport: { width: 1280, height: 1180 },
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

say("=== PROOF (b) — the §VII verification placeholder, in a real conversation ===");
say("runtime: DEVELOPMENT — pnpm dev, CINATRA_RUNTIME_MODE=development,");
say("         CINATRA_TEST_LLM_PROVIDER=scripted, NODE_ENV != production.");
say("         No real provider key is present in .env.local: none was read, used or stored.");
say("         CINATRA_E2E_SETUP_BYPASS=true is set — it skips the SETUP WIZARD only.");
say("         throwaway compose project s9aproofcap (pg 55432, redis 56379), dev port 3105");

// ── 1. a REAL agent run, created by the shipped run-start route ──────────────
await page.goto(`${BASE}${RUN_START_PATH}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
const runUrl = page.url();
const runId = runUrl.split("/").pop();
say("");
say("STEP 1 — a real agent run, created by the SHIPPED run-start route.");
say(`  navigated: ${RUN_START_PATH}`);
say(`  landed:    ${runUrl}`);
say(`  runId:     ${runId}`);

// ── 2. the EXISTING development seed path ────────────────────────────────────
const seeded = await page.evaluate(
  async ({ token, orgId, actorId, id }) => {
    const res = await fetch("/api/development/lifecycle-seed", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ fixture: "repairVerification", orgId, actorId, runId: id }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  { token: SEED_TOKEN, orgId: ORG, actorId: ACTOR, id: runId },
);
say("");
say("STEP 2 — the EXISTING seed path, unchanged: POST /api/development/lifecycle-seed");
say(`  fixture: repairVerification   http status: ${seeded.status}`);
say(`  the seed drives SHIPPED writers only: a real review gate, a real repair,`);
say(`  a real successor gate and a real verification record bound to it.`);
say(`  verificationRecordPresent: ${seeded.body?.verificationRecordPresent}`);
say(`  verificationOutcome:       ${JSON.stringify(seeded.body?.verificationOutcome)}`);
const ref = seeded.body?.ref ?? null;
say(`  ref (the opaque handle the card is asked for): ${ref ? `${ref.slice(0, 24)}… (${ref.length} chars)` : "<none>"}`);
if (!ref) {
  say("SEED RETURNED NO REF — stopping, nothing was photographed.");
  flush();
  await browser.close();
  process.exit(1);
}

// ── 3. the conversation ──────────────────────────────────────────────────────
await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
say("");
say("STEP 3 — the turn, typed into the REAL composer of a real conversation.");
say(`  conversation url: ${page.url()}`);

const MESSAGE = `Show me the verification reading for ${ref}`;
const mentionTokens = (MESSAGE.match(/@/g) ?? []).length;
say(`  driving message: "Show me the verification reading for <ref>"`);
say(`  mention tokens in the driving message: ${mentionTokens} (must be 0)`);

const composer = page.locator('textarea, [contenteditable="true"]').first();
await composer.click();
await composer.fill(MESSAGE);
await page.keyboard.press("Enter");
say("  message sent");

const cardSel = `[data-lifecycle-card="${KIND}"]`;
let appeared = false;
for (let i = 0; i < 60; i += 1) {
  if (await page.locator(cardSel).count()) {
    appeared = true;
    break;
  }
  await page.waitForTimeout(2000);
}
say(`  card appeared within the bounded wait: ${appeared}`);

// ── layout assertions, BEFORE any screenshot ─────────────────────────────────
let thread = null;
for (let i = 0; i < 40; i += 1) {
  thread = await readPersistedThread(page, null);
  const turns = (thread?.messages ?? []).filter((m) => m.role === "assistant");
  if (turns.length > 0) break;
  await page.waitForTimeout(2000);
}
const assistantTurns = (thread?.messages ?? []).filter((m) => m.role === "assistant");
const lastAssistant = assistantTurns[assistantTurns.length - 1] ?? null;
const partsLength = Array.isArray(lastAssistant?.parts) ? lastAssistant.parts.length : 0;
const dataParts = Array.isArray(lastAssistant?.dataParts) ? lastAssistant.dataParts : [];
const slackMode = thread?.slackMode ?? null;

say("");
say("LAYOUT, asserted before any pixel is taken:");
say(`  persisted thread id: ${thread?.id ?? "<none>"}`);
say(`  slackMode===false: ${slackMode === false} (persisted slackMode=${JSON.stringify(slackMode)})`);
say(`  taggedAssistantUserIds: ${JSON.stringify(thread?.taggedAssistantUserIds ?? [])}`);
say(`  parts.length>0: ${partsLength > 0} (parts=${partsLength})`);
say(`  assistant dataParts viewTypes: ${JSON.stringify(dataParts.map((d) => d.viewType))}`);
const layout = await page.evaluate(() => ({
  conversationList: Boolean(document.querySelector("[data-conversation-list]")),
  composerVisible: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
}));
say(`  conversationList present: ${layout.conversationList}`);
say(`  composer visible (in frame): ${layout.composerVisible}`);

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

say("");
say("RATIFIED §VII ANCHORS — every one must be ABSENT (the absence is the evidence).");
say("Read verbatim off LIFECYCLE_CARD_CONTRACTS.verification_summary: the base");
say("`anchors` list plus every member of the ratified `anchorsOneOf` outcome group.");
let allAbsent = true;
for (const a of RATIFIED_ANCHORS) {
  const c = card.anchorCounts[a];
  const absent = c.inCard === 0 && c.inDocument === 0;
  if (!absent) allAbsent = false;
  say(`  ${absent ? "ABSENT " : "PRESENT"}  ${a}   selector=${asSelector(a)}  inCard=${c.inCard} inDocument=${c.inDocument}`);
}
say(`ALL FOUR RATIFIED VERIFICATION ANCHORS ABSENT: ${allAbsent}`);
say(`page errors: ${pageErrors.length} ${JSON.stringify(pageErrors)}`);

await page.locator(cardSel).first().scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/S9a-b__chat_thread__verification-placeholder.png` });
say("captured S9a-b (conversation + composer in frame)");

flush();
await browser.close();
