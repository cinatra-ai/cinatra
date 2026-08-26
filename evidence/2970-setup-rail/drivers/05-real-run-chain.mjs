// THE RUN, made by the app itself: a person asks the assistant in the app's own
// chat to schedule an installed agent once, about an hour ahead; the schedule
// proposal card appears in the reply; the person confirms it ON THE CARD. The
// run then exists in a pre-execution status because the app's own dispatch put
// it there — nothing here inserts a run, a gate or a record.
//
// The model calls in this chain are the REAL provider, configured through the
// app's own setup form (driver 03). `CINATRA_TEST_LLM_PROVIDER` is set in nothing
// this lane starts, and this driver REFUSES to start where it can SEE it: in its
// own environment, and in the app server's process chain. A non-null answer there
// is proof the flag is present; a null answer is consistent with absence and does
// not prove it in the listening process itself.
//
// The negative screens are read off the app server's own log, and their limits
// are stated in README.md: a hit is proof of a problem, a zero is the absence of
// that particular line and nothing more.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const DB = process.env.SUPABASE_DB_URL;
const SERVER_LOG = process.env.SERVER_LOG;
const OUT = process.env.OUT_JSON;
const AGENT = process.env.WALK_AGENT_NAME;
for (const [n, v] of Object.entries({
  WALK_BASE: APP, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD,
  SUPABASE_DB_URL: DB, SERVER_LOG, OUT_JSON: OUT, WALK_AGENT_NAME: AGENT,
})) if (!v) throw new Error(`the chain needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) {
  console.log("ABORT CINATRA_TEST_LLM_PROVIDER is set in this process — the scripted provider is banned from proofs");
  process.exit(1);
}

const EVIDENCE_PATTERNS = {
  preRouterShortCircuits: /explicit-dispatch pre-router HARD short-circuit/g,
  preRouterAttempts: /explicit-dispatch pre-router (?:HARD attempt failed|TERMINAL failure)/g,
  scriptedRuntimeLines: /scripted (?:runtime|provider|stream)|CINATRA_TEST_LLM_PROVIDER/g,
  noProviderRefusals: /NO_LLM_PROVIDER/g,
  mcpDependencyFailures: /424 Failed Dependency|Failed Dependency|could not reach this instance's public MCP/g,
  publicMcpCallbacks: /^\s*POST \/api\/mcp /gm,
  bridgeRunSelects: /\[llm-bridge-run-select\]/g,
};
const EVIDENCE_MUST_BE_ZERO = [
  "preRouterShortCircuits", "preRouterAttempts", "scriptedRuntimeLines",
  "noProviderRefusals", "mcpDependencyFailures",
];

// Read `CINATRA_TEST_LLM_PROVIDER` out of the running app server's PROCESS
// CHAIN (verbatim from evidence/2790-s9f-host-parity/drivers/12-real-chain-sequence.mjs).
// A NON-NULL answer is proof the flag is present; a NULL answer is consistent
// with absence and is not by itself a proof of it.
function readServerScriptedProviderEnv() {
  const port = (() => {
    try { return new URL(APP).port || (APP.startsWith("https") ? "443" : "80"); } catch { return ""; }
  })();
  const run = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return ""; }
  };
  const listening = run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean);
  if (listening.length === 0) return { value: null, readFrom: `unavailable: nothing is listening on port ${port}` };
  let pid = listening[0];
  const chain = [pid];
  for (let hop = 0; hop < 6; hop += 1) {
    const env = run("ps", ["eww", pid]);
    const tokens = env.split(/\s+/).filter((t) => /^[A-Z_][A-Z0-9_]*=/.test(t));
    if (tokens.length > 0) {
      const hit = tokens.find((t) => t.startsWith("CINATRA_TEST_LLM_PROVIDER="));
      return {
        value: hit ? hit.slice("CINATRA_TEST_LLM_PROVIDER=".length) : null,
        readFrom: "process-table", readOfPid: pid, hopsFromListener: hop,
        pidChain: chain.join(">"), envTokensSeen: tokens.length,
      };
    }
    const parent = run("ps", ["-o", "ppid=", "-p", pid]).trim();
    if (!parent || parent === "0" || parent === pid) break;
    pid = parent; chain.push(pid);
  }
  return { value: null, readFrom: `unavailable: no readable environment in the process chain ${chain.join(">")}` };
}

// THE SCREENS ARE READ OVER THIS SEQUENCE'S OWN SLICE of the log, not over the
// whole session: `fromOffset` is the log's length at the instant the sequence
// started, so a line written before it — by an earlier walk in the same server
// session — is counted in `session` and screened in `sequence`. A screen that
// answers for a window the sequence did not drive can neither pass nor fail
// honestly, which is why the two are separated rather than merged.
function readProviderEvidence({ fromOffset = 0 } = {}) {
  let text = "";
  try { text = readFileSync(SERVER_LOG, "utf8"); }
  catch (e) { return { unreadable: e instanceof Error ? e.message : String(e) }; }
  const slice = text.slice(fromOffset);
  const out = {
    serverLog: "<the app server's own log>",
    at: new Date().toISOString(),
    logOffset: text.length,
    countedFromOffset: fromOffset,
    session: {},
  };
  for (const [name, re] of Object.entries(EVIDENCE_PATTERNS)) {
    out.session[name] = (text.match(re) ?? []).length;
    out[name] = (slice.match(re) ?? []).length;
  }
  out.driverScriptedProviderEnv = process.env.CINATRA_TEST_LLM_PROVIDER ?? null;
  const server = readServerScriptedProviderEnv();
  out.serverScriptedProviderEnv = server.value;
  out.serverEnvReadFrom = server.readFrom;
  out.serverEnvReadOfPid = server.readOfPid ?? null;
  out.serverEnvHopsFromListener = server.hopsFromListener ?? null;
  out.serverEnvTokensSeen = server.envTokensSeen ?? null;
  return out;
}

if (readProviderEvidence({ fromOffset: 0 }).serverScriptedProviderEnv) {
  console.log("ABORT the scripted provider switch was FOUND in the app server's process chain");
  process.exit(1);
}

const db = new Client({ connectionString: DB });
await db.connect();
const runsBefore = (await db.query("SELECT id FROM cinatra.agent_runs")).rows.map((r) => r.id);

// The time this run is asked for: about an hour ahead, stated the way a person
// states it. The app reads the schedule out of the sentence; nothing is seeded.
const when = new Date(Date.now() + 60 * 60 * 1000);
const hh = String(when.getHours()).padStart(2, "0");
const mm = String(when.getMinutes()).padStart(2, "0");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const sentence = `Schedule the ${AGENT} to run once today at ${hh}:${mm} ${tz}.`;

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.setDefaultTimeout(420_000);
page.setDefaultNavigationTimeout(420_000);
const signIn = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: EMAIL, password: PASSWORD } });
console.log(signIn.ok() ? "PASS signed in" : `FAIL sign-in ${signIn.status()}`);
if (!signIn.ok()) process.exit(1);

const timeline = [];
const stamp = (what, extra = {}) => timeline.push({ at: new Date().toISOString(), what, ...extra });

await page.goto("/chat", { waitUntil: "domcontentloaded" });
await page.waitForSelector('div[contenteditable="true"][role="textbox"]');
stamp("the chat is open", { source: "driver clock" });

// A WARM-UP TURN, and why it is here rather than hidden.
//
// The model's hosted MCP connector fetches this instance's tool list over the
// public origin, and on the FIRST turn of a cold OAuth path that fetch answers
// 424 (the app's own 401 challenge, unanswered) — the turn then reports the
// tools unavailable, and the NEXT turn resolves the list and works. That is a
// real transient of the environment, not of the change under proof, so the
// sequence absorbs it in the open: one harmless turn is sent FIRST, and only
// then is the log offset the negative screens are read from taken. The screens
// therefore answer for the measured sequence, and `session` beside them still
// carries the whole server session including this warm-up — nothing is hidden,
// it is scoped.
await page.click('div[contenteditable="true"][role="textbox"]');
await page.type('div[contenteditable="true"][role="textbox"]', "Hello — are your platform tools available?", { delay: 8 });
await page.keyboard.press("Enter");
// WAIT FOR THE WARM-UP TO FINISH, not for a fixed number of seconds: a turn
// still in flight writes its lines AFTER the offset is taken, which is how the
// first version of this warm-up left the incident inside the measured slice.
const warmUpDb = new Client({ connectionString: DB });
await warmUpDb.connect();
const assistantTurnsBefore = Number(
  (await warmUpDb.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role = 'assistant'")).rows[0].n,
);
let warmedUp = false;
for (let i = 0; i < 90 && !warmedUp; i += 1) {
  const n = Number(
    (await warmUpDb.query("SELECT count(*) AS n FROM cinatra.assistant_turns WHERE role = 'assistant'")).rows[0].n,
  );
  warmedUp = n > assistantTurnsBefore;
  if (!warmedUp) await page.waitForTimeout(2000);
}
await warmUpDb.end();
await page.waitForTimeout(15_000);
stamp("a warm-up turn was sent and answered before the measured sequence", { warmedUp, source: "driver clock" });
console.log(`NOTE the warm-up turn was answered: ${warmedUp}`);

const startOffset = (() => {
  try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; }
})();
const before = readProviderEvidence({ fromOffset: startOffset });
for (const k of EVIDENCE_MUST_BE_ZERO) {
  if (before[k] > 0) { console.log(`ABORT ${k}=${before[k]} in this sequence's own slice before it started`); process.exit(1); }
  if (before.session?.[k] > 0) console.log(`NOTE ${k}=${before.session[k]} earlier in this server session, warm-up included (outside the measured sequence)`);
}

await page.click('div[contenteditable="true"][role="textbox"]');
await page.type('div[contenteditable="true"][role="textbox"]', sentence, { delay: 8 });
await page.keyboard.press("Enter");
stamp("the person asked for the schedule in their own words", { sentence, source: "driver clock" });

const CARD = '[data-lifecycle-card="trigger_schedule_proposal"][data-lifecycle-card-state="pending"]';
let appeared = await page
  .waitForSelector(CARD, { timeout: 240_000 })
  .then(() => true)
  .catch(() => false);
if (!appeared) {
  // The assistant asked something back. A conversation is allowed to have two
  // turns in it; the driver answers ONCE, in the person's own words, and never
  // reaches past the chat to make the card appear.
  console.log("NOTE the first turn did not carry the card — answering the assistant once");
  await page.click('div[contenteditable="true"][role="textbox"]');
  await page.type(
    'div[contenteditable="true"][role="textbox"]',
    `Yes — the ${AGENT}, one run only, today at ${hh}:${mm} ${tz}. Please set it up.`,
    { delay: 8 },
  );
  await page.keyboard.press("Enter");
  stamp("the person answered the assistant's question", { source: "driver clock" });
  appeared = await page
    .waitForSelector(CARD, { timeout: 300_000 })
    .then(() => true)
    .catch(() => false);
}
if (!appeared) { console.log("FAIL no schedule proposal card appeared in the conversation"); process.exit(1); }
stamp("the schedule proposal card appeared in the assistant's reply", { source: "driver clock" });
console.log("PASS the assistant answered with a schedule proposal card");

const confirm = page.locator('[data-action="confirm-schedule-proposal"]').first();
await confirm.scrollIntoViewIfNeeded();
await confirm.click();
stamp("the person confirmed the schedule ON THE CARD", { source: "driver clock" });
// WHAT THE CONFIRMATION HAS TO PRODUCE is the RUN — the card's own repaint is
// read and written down, never asserted: this evidence is about the run page,
// and a card that has not repainted yet would otherwise abort a sequence whose
// real end state (a run row the app's own dispatch created) is already there.
const settled = await page
  .waitForSelector('[data-lifecycle-card="trigger_schedule_proposal"][data-lifecycle-card-state="decided"]', { timeout: 120_000 })
  .then(() => true)
  .catch(() => false);
const cardStateAfterConfirm = await page
  .locator('[data-lifecycle-card="trigger_schedule_proposal"]')
  .first()
  .getAttribute("data-lifecycle-card-state")
  .catch(() => null);
stamp("the card was read back after the confirmation", { settled, cardStateAfterConfirm, source: "driver clock" });
console.log(`NOTE the card reads "${cardStateAfterConfirm}" after Confirm (settled-within-120s: ${settled})`);

// THE RUN THE APP'S OWN DISPATCH CREATED — found by difference, never by insert.
let run = null;
for (let i = 0; i < 60 && !run; i += 1) {
  const rows = (await db.query(
    `SELECT r.id, r.status, r.created_at, r.started_at, r.human_present, r.source_type,
            r.template_id, t.package_name, t.name
       FROM cinatra.agent_runs r JOIN cinatra.agent_templates t ON t.id = r.template_id
      ORDER BY r.created_at DESC`,
  )).rows;
  run = rows.find((r) => !runsBefore.includes(r.id)) ?? null;
  if (!run) await page.waitForTimeout(2000);
}
if (!run) { console.log("FAIL no new run row appeared after the confirmation"); process.exit(1); }
console.log(`PASS the app's own dispatch created run ${run.id} in status ${run.status}`);

const trigger = (await db.query(
  `SELECT * FROM cinatra.agent_run_triggers WHERE run_id = $1`, [run.id],
)).rows[0] ?? null;
const threadUrl = page.url();
const after = readProviderEvidence({ fromOffset: startOffset });
// The two POSITIVE counters are already sequence-scoped by the slice, and are
// named that way rather than as a delta over a whole-session count.
after.inThisSequence = Object.fromEntries(
  ["publicMcpCallbacks", "bridgeRunSelects"].map((k) => [k, after[k] ?? 0]),
);
for (const k of EVIDENCE_MUST_BE_ZERO) {
  if (after[k] > 0) { console.log(`FAIL ${k}=${after[k]} after the sequence — the chain is not clean`); process.exit(1); }
}
const usage = (await db.query(
  `SELECT provider, model, source, operation, count(*) AS calls,
          sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
          min(occurred_at) AS first_at, max(occurred_at) AS last_at
     FROM cinatra.usage_events
    WHERE occurred_at > now() - interval '60 minutes'
    GROUP BY 1,2,3,4 ORDER BY 5 DESC`,
)).rows;

const [vendor, slug] = String(run.package_name).replace(/^@/, "").split("/");
const runUrl = `/agents/${vendor}/${slug}/${run.id}`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({
  run, trigger, runUrl, threadUrl, sentence, timeline, cardStateAfterConfirm,
  providerEvidence: { before, after }, usage,
}, null, 2)}\n`);
console.log(`PASS run page is ${runUrl}`);
console.log(`PASS wrote the chain readback`);
await db.end();
await browser.close();
