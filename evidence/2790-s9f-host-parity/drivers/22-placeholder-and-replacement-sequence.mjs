// ---------------------------------------------------------------------------
// cinatra#2997 (PR #2890) — THE PLACEHOLDER, AND THE SCREEN THAT REPLACES IT.
//
// This file is `14-real-chain-review-sequence.mjs` carried forward: the same
// chain, the same negative screens, the same shutter, the same clock, the same
// refusals. What it walks is the maintainer's request for changes, verbatim:
//
//   "The 'Agentic Run Progress' card should basically just be a card (maybe even
//    an empty review screen) with a spinning icon which is a temporary
//    placeholder for the review screen. Once the agent is done and the output
//    generated, that 'Agentic Run Progress' card is being automatically replaced
//    with the 'Review requested' screen. On the run page, the same is true.
//    Also, the 'Open the run page' link in the top right below the 'Agentic Run
//    Progress' card should be removed."
//
// SO THE PICTURES ARE A BEFORE AND AN AFTER OF ONE SLOT, on one run, in one
// sequence, on both surfaces:
//
//   S3a / S3a dark — the CHAT, while the agent works: the card is the
//                    placeholder (the spinner and the empty review screen).
//   R7a / R7a dark — the RUN PAGE, at the same moment, the same reading.
//   S3  / S3 dark  — the CHAT again, after the run finished and its output
//                    opened the review: the SAME slot now holds the 'Review
//                    requested' screen. No new turn was typed between them and
//                    nobody asked for it — which is the whole claim, so the
//                    driver types nothing at all after the decision.
//   R7  / R7 dark  — the RUN PAGE, the same replacement in the run panel.
//
// AND THE LINK IS COUNTED, on every one of the eight: `document.querySelectorAll`
// for the removed link's own test id and for its label text, recorded as ZERO on
// each record. An absence nobody counts is an absence nobody can check.
//
// WHAT IS UNCHANGED FROM 14, and deliberately: the turn names no package token in
// either form the pre-router reads; nothing here clears the sealed provider row;
// `CINATRA_TEST_LLM_PROVIDER` is unset in this process and the app server's own
// value is read at every shutter; every shutter passes `assertRealChain`, which
// refuses to photograph a state a stood-in leg produced. The boundary those
// readings can and cannot draw is stated in README.md, unchanged.
//
// THE RUN ID'S STRONG BINDING MOVED, and the move is this change's own doing. 14
// read the run id off the inline run panel's link-out — the link this request
// removes. The card names its run itself (`data-inline-run-card="<runId>"`, the
// attribute the transcript suites already count), so that attribute is the strong
// binding now: it is the same platform-built value the href was built from, read
// from the same card, one attribute earlier.
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const APP = process.argv[2];
const OUT = process.argv[3];
const REPO_ROOT = process.argv[4];
const SHOT_DIR_REL = "evidence/2790-s9f-host-parity/captures";
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const DB = process.env.SUPABASE_DB_URL;
/** The app server's OWN log. Every provider-evidence counter is read from it. */
const SERVER_LOG = process.env.S9F_SERVER_LOG;
if (!APP || !OUT || !REPO_ROOT || !ACTOR.email || !ACTOR.password || !DB || !SERVER_LOG) {
  throw new Error(
    "usage: 14-real-chain-review-sequence.mjs <appOrigin> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, S9F_SERVER_LOG",
  );
}
/**
 * THE REDACTION, AND WHY IT IS IN THE DRIVER RATHER THAN APPLIED AFTERWARDS.
 *
 * Two strings this sequence handles are operational rather than evidential and
 * must never reach a committed artifact: the lane's PUBLIC ORIGIN (a real
 * externally-resolvable host) and the absolute path of the app server's log
 * (a lane filesystem path). Neither is a fact about this branch.
 *
 * They are replaced HERE, at the moment the record is written, so the recorder's
 * own output is already clean — nothing is scrubbed after the fact, and no
 * committed file ever held them.
 */
const REDACTIONS = [
  [() => process.env.S9F_PUBLIC_ORIGIN ?? "", "<the lane's public origin>"],
  [() => SERVER_LOG, "<the app server's own log>"],
];
function redact(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [get, to] of REDACTIONS) {
      const from = get();
      if (from) out = out.split(from).join(to);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  // A DATE IS A VALUE, NOT A BAG OF KEYS. `Object.entries(new Date())` is empty,
  // so walking a Date as a plain object silently replaces every database
  // timestamp with `{}` — which is how a record loses the very column it exists
  // to carry. Dates pass through untouched; they can hold no secret.
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

// THIS DRIVER REFUSES TO RUN UNDER THE SCRIPTED FLAG IN ITS OWN ENVIRONMENT.
// That is all this guard checks — the driver's process, not the app server's.
// It is the WEAK half and is labelled as such wherever it is recorded
// (`driverScriptedProviderEnv`); the server's own value is read separately at
// every shutter, one hop above the listening process, and CANNOT exclude a
// variable injected into the listener alone.
if (process.env.CINATRA_TEST_LLM_PROVIDER) {
  throw new Error(
    `CINATRA_TEST_LLM_PROVIDER is set in THIS process (${process.env.CINATRA_TEST_LLM_PROVIDER}) — the driver refuses to run under it; note this says nothing about the app server's own environment, which is read separately at every shutter`,
  );
}
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const log = [];
const say = (m) => {
  const line = redact(String(m));
  log.push(`${new Date().toISOString()} ${line}`);
  console.log(line);
};

// --- the shipped anchors, read off the components, never invented here -------
const CONVERSATION_LIST = "[data-conversation-list]";
const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const CHAT_PROMPT = '[data-testid="chat-prompt-input"]';
const CHIP = "[data-recommendation-chip]";
const CHIP_ROW = "[data-run-recommendation-chip-row]";
const RUN_SURFACE = '[data-conformance-id="run-surface"]';
const RAIL_COLUMN = "[data-run-step-rail-column]";
const DETAIL_COLUMN = "[data-run-detail-column]";
const RAIL_STEP = '[data-conformance-id="recommendation-rail-step"]';
const RAIL_INDICATOR = '[data-conformance-id="recommendation-rail-indicator"]';
/** The inline run progress card in the chat transcript, and its skill picker. */
const INLINE_RUN_CARD = "[data-inline-run-card]";
const RUN_CARD_SKILL_PICKER = "[data-hitl-skill-picker]";

/** ONE press per chip, in this order, so every mark the drawing names appears. */
const DECISION_ORDER = ["confirm", "adjust", "skip", "confirm"];

/**
 * THE TURN THAT STARTS THE RUN — and the one thing this re-shoot is about.
 *
 * WHAT MAKES IT REAL. It carries NO package token in either form the pre-router
 * reads: no `@cinatra-ai/<slug>`, no `cinatra_<slug>`. `detectExplicitDispatchPackage`
 * requires BOTH a verb AND a package reference, so it returns null here, the hard
 * server-side short-circuit never fires, and the SOFT directive is never prepended
 * either. Nothing in the platform tells the model what to do with this sentence.
 * The agent is named the way a person names it: by the display name on its card.
 *
 * So the platform's own deterministic path cannot turn this turn into a run, and
 * its counters read 0. That the run was therefore started by a MODEL calling
 * `agent_run` is an ARCHITECTURAL INFERENCE from that absence plus the run's own
 * chat-launch carrier — not a measurement: no field here records who invoked the
 * tool, and the `/api/mcp` counter is expressly unattributed. README.md carries
 * the same boundary.
 *
 * WHY THE IDEA IS SPELLED OUT, since it looks like the thing the withdrawn round
 * did. It is not. The withdrawn turn's JSON mattered because that turn ALSO named
 * the package: the pre-router matched, dispatched server-side, and read the JSON
 * on its own brace-matched fast path — no model anywhere. With no package token
 * there is no pre-router to reach, so nothing in the platform can read this object
 * at all; the model has to read it and pass it, or the run starts without it.
 *
 * And it must not start without it. MEASURED on this lane across nine real runs:
 * a dispatch that carries no `inputParams` parks the run on the agent's setup
 * field and then on its trigger, and NEITHER surface on this branch draws a
 * control for that trigger state — so the run never executes and R6 has no
 * decided-and-run page to photograph. Stating the input is what a person does
 * when the agent needs it; it removes a stall, not a step.
 */
const IDEA = {
  title: "Connector rollout note",
  summary: "The connector ships this week and replaces the manual export step.",
  outline: ["Summary", "Rollout"],
};
const MESSAGE =
  "Please have the Blog Draft Writer Agent write me a blog draft. " +
  `Here is the idea it should work from: ${JSON.stringify(IDEA)}`;
/** A distinctive phrase of the turn, used only to confirm it was typed and sent
 *  — the old check keyed on the package token this message deliberately omits. */
const TURN_MARKER = IDEA.title;

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

/** THE CLOCK. The `db` payload on each row is read from database columns, with the
 *  columns named in the query above it; `at` is THIS PROCESS'S clock. Nothing
 *  here is read off a screen. */
const timeline = [];
const stamp = async (step, what, rows) => {
  const row = { step, what, at: new Date().toISOString(), db: redact(rows) };
  timeline.push(row);
  say(`TIMELINE ${step} ${what} ${JSON.stringify(rows)}`);
  return row;
};

/** The run's own rows, as the database holds them at this instant. */
async function runRows(runId) {
  if (!runId) return null;
  const [run] = await q(
    `select id, status, human_present, created_at, completed_at, coalesce(error,'') as error from cinatra.agent_runs where id=$1`,
    [runId],
  );
  const park = await q(
    `select checkpoint, status, created_at, resolved_at from cinatra.lifecycle_continuation_park where run_id=$1`,
    [runId],
  );
  const selections = await q(
    `select skill_id, selection_source, selected_at from cinatra.run_selected_skill_revisions where run_id=$1 order by skill_id`,
    [runId],
  );
  const representations = await q(
    `select id, artifact_id, resource_id, revision, form, created_at from cinatra.representation where created_by_run_id=$1 order by created_at`,
    [runId],
  );
  const outbox = await q(
    `select event_id, artifact_id, representation_revision_id, emitter, origin_kind, created_at, processed_at from cinatra.artifact_produced_outbox where producer_run_id=$1`,
    [runId],
  );
  const gates = await q(
    `select id, review_task_id, status, created_at from cinatra.artifact_review_gates where run_id=$1`,
    [runId],
  );
  return { run, park, selections, representations, outbox, gates };
}

/**
 * THE PROVIDER-EVIDENCE READER.
 *
 * Every counter below is a COUNT OF LINES IN THE APP SERVER'S OWN LOG, taken at
 * the instant it is read. Nothing here is a claim the driver makes about itself:
 * the log is written by the server, and the patterns are the server's own
 * strings.
 *
 *   preRouterShortCircuits  the deterministic chat dispatch's success line. Any
 *                           hit means a turn was dispatched WITHOUT a model.
 *   preRouterAttempts       its failure/fallthrough lines, counted too, so a
 *                           near-miss cannot hide behind a zero.
 *   scriptedRuntimeLines    any line naming the scripted provider/runtime.
 *   noProviderRefusals      the bridge's own `NO_LLM_PROVIDER` refusal.
 *   mcpDependencyFailures   the 424 the previous attempt died on.
 *   publicMcpCallbacks      `POST /api/mcp` — posts to this instance's own MCP
 *                           surface. UNATTRIBUTED: the request log does not
 *                           record the caller.
 *   bridgeRunSelects        `[llm-bridge-run-select]` — the agent's own step
 *                           reaching the model bridge under its run token.
 */
const EVIDENCE_PATTERNS = {
  preRouterShortCircuits: /explicit-dispatch pre-router HARD short-circuit/g,
  preRouterAttempts: /explicit-dispatch pre-router (?:HARD attempt failed|TERMINAL failure)/g,
  scriptedRuntimeLines: /scripted (?:runtime|provider|stream)|CINATRA_TEST_LLM_PROVIDER/g,
  noProviderRefusals: /NO_LLM_PROVIDER/g,
  // NOT a bare `424`: a request-duration line ("in 424ms") would answer to that
  // and abort an honest sequence. The three strings below are the failure's own.
  mcpDependencyFailures: /424 Failed Dependency|Failed Dependency|could not reach this instance's public MCP/g,
  publicMcpCallbacks: /^\s*POST \/api\/mcp /gm,
  bridgeRunSelects: /\[llm-bridge-run-select\]/g,
};
/**
 * MUST be zero at every shutter. A non-zero one ABORTS rather than shoots.
 *
 * These are NEGATIVE SCREENS, and they are worth what a negative screen is
 * worth: each one names a line the server writes when a leg goes wrong, so a hit
 * is proof of a problem while a zero is only the absence of that particular
 * line. Two of them are deliberately BROAD (`Failed Dependency` on its own would
 * also catch an unrelated 424) — broad is the safe direction for a screen whose
 * only power is to stop the shoot.
 *
 * Nothing here identifies which runtime answered a model call, and no field in
 * this block can. What the fields beside the screens carry is narrower: the
 * scripted switch was not found in the app server's process chain (one hop above
 * the listener), the sealed provider row reads present before AND after the step,
 * and the unattributed `/api/mcp` counter moved. README.md draws the boundary.
 */
const EVIDENCE_MUST_BE_ZERO = [
  "preRouterShortCircuits",
  "preRouterAttempts",
  "scriptedRuntimeLines",
  "noProviderRefusals",
  "mcpDependencyFailures",
];
function readProviderEvidence() {
  let text = "";
  try {
    text = readFileSync(SERVER_LOG, "utf8");
  } catch (e) {
    return { unreadable: e instanceof Error ? e.message : String(e) };
  }
  const out = { serverLog: "<the app server's own log>", at: new Date().toISOString() };
  for (const [name, re] of Object.entries(EVIDENCE_PATTERNS)) {
    out[name] = (text.match(re) ?? []).length;
  }
  // ---- THE STRUCTURAL HALF, AND WHOSE ENVIRONMENT IT READS ----------------
  //
  // The scripted runtime has exactly one activation switch,
  // `CINATRA_TEST_LLM_PROVIDER`, and it is read by the APP SERVER's process —
  // not by this one. A driver that reports its OWN env is answering a question
  // nobody asked, which is precisely the objection a convergence review raised
  // against the first version of this block.
  //
  // So both are recorded and NAMED apart:
  //   driverScriptedProviderEnv — this process's value. It only says the driver
  //                               refused to start under the flag.
  //   serverScriptedProviderEnv — the value found in the app server's PROCESS
  //                               CHAIN, read from the process table (`ps eww`)
  //                               at the nearest ancestor of the listening
  //                               process that has a readable environment. It is
  //                               the stronger of the two, and it still cannot
  //                               exclude a variable injected into the listener
  //                               alone — see the asymmetry below.
  //   serverEnvReadFrom         — how that answer was obtained, so a reader can
  //                               tell a real read from a missing one.
  out.driverScriptedProviderEnv = process.env.CINATRA_TEST_LLM_PROVIDER ?? null;
  const server = readServerScriptedProviderEnv();
  out.serverScriptedProviderEnv = server.value;
  out.serverEnvReadFrom = server.readFrom;
  out.serverEnvReadOfPid = server.readOfPid ?? null;
  out.serverEnvHopsFromListener = server.hopsFromListener ?? null;
  out.serverEnvTokensSeen = server.envTokensSeen ?? null;
  return out;
}

/**
 * Read `CINATRA_TEST_LLM_PROVIDER` out of the running app server's PROCESS CHAIN
 * — the chain, not the listening process itself; the asymmetry is below.
 *
 * WHAT THIS CAN AND CANNOT ESTABLISH, first, because a convergence review found
 * the earlier wording overclaimed it. The Next server rewrites its argv, so on
 * this platform `ps eww` prints no environment for the LISTENING process itself
 * and the read walks up to the nearest ancestor that has one (`hopsFromListener`
 * records how far). An ancestor's environment is what the child INHERITS, but a
 * child can also be given a variable the parent never had (`VAR=x cmd`). So:
 *
 *   · a NON-NULL answer is proof the flag is present, and aborts the sequence;
 *   · a NULL answer is consistent with the flag being absent, and is NOT by
 *     itself a proof of absence in the listening process.
 *
 * It is recorded with `readFrom`, the pid actually read, the hop count and the
 * number of environment tokens seen, so a reader can weigh it rather than take
 * it. What the evidence directory leans on for the AGENT STEP is a different and
 * strongest available reading, and it is an ARGUMENT rather than a proof:
 * `resolveConfiguredLlmRuntime` reaches the scripted runtime only as a LAST
 * RESORT, after every configured candidate failed to resolve, and rows `T1c`/`T3a`
 * read the sealed provider ROW back on both sides of the step — the row, not
 * `resolveProviderAdapter` at the instant of the call.
 *
 * HOW THE PROCESS IS FOUND, and why it is not simply a pid handed in: the server
 * whose environment matters is the one ANSWERING THIS DRIVER'S REQUESTS, so it is
 * resolved from the app origin's own listening socket (`lsof -ti tcp:<port>`).
 * A pid passed by the operator would be a claim; a listening socket is the thing.
 *
 * WHY IT THEN WALKS UP. On this platform `ps eww` prints no environment for a
 * process that rewrote its argv, which the Next server does — so the listening
 * process itself answers nothing. Its environment is INHERITED from the process
 * that spawned it, so the read walks the parent chain to the nearest ancestor
 * whose environment is readable and reports THAT, together with the pid it
 * actually read and how many hops up it was. A reader can re-run the same two
 * commands and get the same answer.
 *
 * Only the ONE variable is extracted; nothing else from that environment is
 * returned, kept or recorded.
 *
 * `readFrom` distinguishes an ABSENT value from an UNREAD one — the caller
 * treats "unread" as a failure, because an unread switch is not an absent one.
 */
function readServerScriptedProviderEnv() {
  const port = (() => {
    try {
      return new URL(APP).port || (APP.startsWith("https") ? "443" : "80");
    } catch {
      return "";
    }
  })();
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const listening = run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean);
  if (listening.length === 0) {
    return { value: null, readFrom: `unavailable: nothing is listening on port ${port}` };
  }
  let pid = listening[0];
  const chain = [pid];
  for (let hop = 0; hop < 6; hop += 1) {
    const env = run("ps", ["eww", pid]);
    const tokens = env.split(/\s+/).filter((t) => /^[A-Z_][A-Z0-9_]*=/.test(t));
    if (tokens.length > 0) {
      const hit = tokens.find((t) => t.startsWith("CINATRA_TEST_LLM_PROVIDER="));
      return {
        value: hit ? hit.slice("CINATRA_TEST_LLM_PROVIDER=".length) : null,
        readFrom: "process-table",
        readOfPid: pid,
        hopsFromListener: hop,
        pidChain: chain.join(">"),
        envTokensSeen: tokens.length,
      };
    }
    const parent = run("ps", ["-o", "ppid=", "-p", pid]).trim();
    if (!parent || parent === "0" || parent === pid) break;
    pid = parent;
    chain.push(pid);
  }
  return { value: null, readFrom: `unavailable: no readable environment in the process chain ${chain.join(">")}` };
}

/**
 * The counters at the START of this sequence. Every later reading reports its
 * DELTA against this, because the raw counts include every earlier run on the
 * same lane server and a cumulative number cannot say what THIS run did.
 */
let evidenceBaseline = null;

/**
 * Read the evidence and REFUSE to continue unless the chain still looks real.
 *
 * Three things are enforced, and the last two are the ones a convergence review
 * asked for:
 *   · every must-be-zero screen is still zero;
 *   · `CINATRA_TEST_LLM_PROVIDER` is absent at the nearest readable ancestor in
 *     the app server's process chain, and was actually READ rather than merely
 *     unavailable — an unread value is a failure here, not a pass. Absence there
 *     cannot exclude a variable injected into the listening process alone;
 *   · once the sequence is under way, the POSITIVE counter must have MOVED: a
 *     sequence in which this instance's own MCP surface is never posted to would
 *     leave `publicMcpCallbacks` flat, and a flat counter means the run under the
 *     shutter is not doing what a dispatched run does. It is a LIVENESS check, not
 *     an attribution: the request log does not say who posted.
 */
function assertRealChain(where, { requireMovement = false } = {}) {
  const ev = readProviderEvidence();
  if (evidenceBaseline) {
    ev.deltaSinceStart = Object.fromEntries(
      ["publicMcpCallbacks", "bridgeRunSelects"].map((k) => [
        k,
        (ev[k] ?? 0) - (evidenceBaseline[k] ?? 0),
      ]),
    );
  }
  const broken = EVIDENCE_MUST_BE_ZERO.filter((k) => (ev[k] ?? 0) > 0);
  say(`EVIDENCE ${where} ${JSON.stringify(ev)}`);
  if (broken.length > 0) {
    throw new Error(
      `a stood-in-leg screen fired at ${where}: ${broken.map((k) => `${k}=${ev[k]}`).join(", ")}`,
    );
  }
  if (ev.serverScriptedProviderEnv !== null) {
    throw new Error(
      `CINATRA_TEST_LLM_PROVIDER=${ev.serverScriptedProviderEnv} was found in the app server's process chain — the scripted runtime is reachable and this sequence refuses to photograph it`,
    );
  }
  if (ev.serverEnvReadFrom !== "process-table") {
    throw new Error(
      `no readable environment was found in the app server's process chain (${ev.serverEnvReadFrom}) — an unread switch is not an absent one`,
    );
  }
  if (requireMovement && !(ev.deltaSinceStart?.publicMcpCallbacks > 0)) {
    throw new Error(
      `this instance's own MCP surface was never posted to during the sequence (publicMcpCallbacks delta ${ev.deltaSinceStart?.publicMcpCallbacks}) — a dispatched run does not leave that counter flat`,
    );
  }
  return ev;
}

const browser = await chromium.launch({ headless: true });
// 1440x1700 CSS px at deviceScaleFactor 2 — this lane's committed walk contract.
const VIEWPORT = { width: 1440, height: 1700 };
const ctx = await browser.newContext({ viewport: { ...VIEWPORT }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
/** The lifecycle wire, presence + status only — never a body, never a value. */
const wire = [];
page.on("response", (res) => {
  const p = new URL(res.url()).pathname;
  if (p.startsWith("/api/lifecycle-views/") || p.startsWith("/api/chat") || p.startsWith("/api/assistants"))
    wire.push({ method: res.request().method(), path: p, status: res.status(), at: new Date().toISOString() });
});

const stripDevOverlay = async () => {
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
};

// --- counting rules ---------------------------------------------------------
//   frame — document.querySelectorAll(sel).length on THIS document.
//   root  — the named card root's OWN subtree INCLUDING the root element.
async function counts(selectors, rootSel) {
  const out = [];
  for (const { selector, scope } of selectors) {
    let count = 0;
    if (scope === "frame") {
      count = await page.evaluate((s) => document.querySelectorAll(s).length, selector);
    } else {
      count = await page
        .evaluate(
          ({ s, r }) => {
            const root = document.querySelector(r);
            if (!root) return 0;
            return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
          },
          { s: selector, r: rootSel },
        )
        .catch(() => 0);
    }
    out.push({ selector, scope, count });
  }
  return out;
}

const RECOMMENDATION_ASSERTIONS_CHAT = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: "[data-chat-thread-recommendation-hold]", scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: CHIP, scope: "root" },
  { selector: CHIP_ROW, scope: "frame" },
];

/** THE HELD TURN'S SET. The plan: "An agentic run progress card is not visible
 *  while the recommended skills can be selected". So the held cell COUNTS the
 *  run card, and the count it must record is ZERO — an absence nobody counts is
 *  an absence nobody can check. */
const CHAT_HELD_ASSERTIONS = [
  ...RECOMMENDATION_ASSERTIONS_CHAT,
  { selector: INLINE_RUN_CARD, scope: "frame" },
];

/** THE DECIDED TURN'S SET. The other half: the run card is counted (present) and
 *  the skill picker inside it is counted (ZERO). */
const CHAT_DECIDED_ASSERTIONS = [
  ...RECOMMENDATION_ASSERTIONS_CHAT,
  { selector: INLINE_RUN_CARD, scope: "frame" },
  { selector: RUN_CARD_SKILL_PICKER, scope: "frame" },
];

/** THE RUN PAGE'S SET — the two-column frame, the rail, the step row and the
 *  chip row, all counted on the screen the picture was taken on. */
const RUN_PAGE_ASSERTIONS = [
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: RUN_SURFACE, scope: "frame" },
  { selector: RAIL_COLUMN, scope: "frame" },
  { selector: DETAIL_COLUMN, scope: "frame" },
  { selector: RAIL_STEP, scope: "frame" },
  { selector: RAIL_INDICATOR, scope: "frame" },
  { selector: CHIP_ROW, scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: CHIP, scope: "root" },
];

async function rootAttributes(rootSel) {
  return page
    .evaluate((r) => {
      const el = document.querySelector(r);
      if (!el) return null;
      const out = {};
      for (const a of el.attributes) out[a.name] = a.value;
      delete out.class;
      return out;
    }, rootSel)
    .catch(() => null);
}

async function chipReadout() {
  return page
    .evaluate((r) => {
      const root = document.querySelector(r);
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

/** THE TRANSCRIPT, as text — the proof that the whole chat is in frame. */
async function transcriptReadout() {
  return page
    .evaluate((listSel) => {
      const list = document.querySelector(listSel);
      if (!list) return null;
      const box = list.getBoundingClientRect();
      return {
        turns: [...list.children].length,
        listTop: Math.round(box.top),
        listBottom: Math.round(box.bottom),
        listFullyInViewport: box.top >= 0 && box.bottom <= window.innerHeight,
        text: list.innerText.replace(/\n{2,}/g, "\n").slice(0, 3000),
      };
    }, CONVERSATION_LIST)
    .catch(() => null);
}

/**
 * THE RUN PAGE'S OWN READOUT — every claim the run-page cells make, MEASURED.
 *
 *   · which column the chip row is a descendant of (the drawing's whole point:
 *     "a gate step opens the gate's own surface in place — right here in the run
 *     detail, under the same rail, never as a standalone document");
 *   · whether anything is drawn inline UNDER the rail row (must be false);
 *   · the rail row's own reading — selected / settled, and what its circle says;
 *   · the ordered rail row labels, so "at the trigger position" is readable;
 *   · whether an "Agentic Run Progress" section is on the screen at all.
 */
async function runSurfaceReadout() {
  return page
    .evaluate(
      ({ surfaceSel, railSel, detailSel, stepSel, indicatorSel, rowSel }) => {
        const surface = document.querySelector(surfaceSel);
        const rail = document.querySelector(railSel);
        const detail = document.querySelector(detailSel);
        const step = document.querySelector(stepSel);
        const row = document.querySelector(rowSel);
        const headings = [...document.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim());
        return {
          surfacePresent: Boolean(surface),
          surfaceChildren: surface ? surface.children.length : null,
          railColumnPresent: Boolean(rail),
          detailColumnPresent: Boolean(detail),
          chipRowPresent: Boolean(row),
          chipRowInDetailColumn: Boolean(detail && row && detail.contains(row)),
          chipRowInRailColumn: Boolean(rail && row && rail.contains(row)),
          chipRowInsideRailRow: Boolean(step && row && step.contains(row)),
          railStepPresent: Boolean(step),
          railStepSelected: step?.getAttribute("data-recommendation-step-selected") ?? null,
          railStepSettled: step?.getAttribute("data-recommendation-step-settled") ?? null,
          railStepText: step?.textContent.trim() ?? null,
          railStepIndicatorText:
            step?.querySelector(indicatorSel)?.textContent.trim() ?? null,
          // THE COMPLETED READING, measured rather than described: the circle's
          // own text (empty — the numeral is replaced by the check glyph) and
          // whether the indicator holds a glyph element at all.
          railStepIndicatorHasCheckGlyph: Boolean(
            step?.querySelector(indicatorSel)?.querySelector("svg"),
          ),
          railRowLabels: rail
            ? [...rail.children].map((c) => c.textContent.trim().replace(/\s+/g, " ").slice(0, 60))
            : null,
          agenticRunProgressHeadings: headings.filter((h) => h === "Agentic Run Progress").length,
          headings: headings.slice(0, 12),
        };
      },
      {
        surfaceSel: RUN_SURFACE,
        railSel: RAIL_COLUMN,
        detailSel: DETAIL_COLUMN,
        stepSel: RAIL_STEP,
        indicatorSel: RAIL_INDICATOR,
        rowSel: CHIP_ROW,
      },
    )
    .catch(() => null);
}

const records = [];
const results = [];

/**
 * Apply the palette next-themes applies through the shipped theme control.
 *
 * STATED BECAUSE IT IS A SHORTCUT: this sets the root class directly rather than
 * pressing the header's own theme toggle. It is the same mechanism every earlier
 * capture round in this lane used, and it writes ONLY the class next-themes
 * writes — it arranges nothing the recorder is about to measure, because no
 * assertion in this file reads a class. A cell that needed the toggle's own
 * behaviour proven would have to press it.
 */
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

/**
 * THE SHUTTER. Always the FULL BROWSER WINDOW — no `fullPage`, no `clip`.
 */
async function shoot(cell, { host, kind, declaredState, rootSel, assertions, note, runId, dbAt, fullPage = false, extra = {} }) {
  // THE GATE BEFORE THE SHUTTER. Read the server's own log and refuse to
  // photograph a state a stood-in leg produced. It throws rather than warns:
  // the sequence's whole claim is that no such leg exists.
  const providerEvidence = assertRealChain(cell, { requireMovement: true });
  await stripDevOverlay();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  // THE SHUTTER IS THE WHOLE WINDOW by default. `fullPage` is used for exactly
  // two cells (`R2`/`R4`), whose own contract is the page "uncropped and
  // full-length"; it is still a crop of nothing — it is MORE of the same page,
  // and every record says which of the two it is in `framing`.
  await page.screenshot({ path: abs, scale: "device", fullPage });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const observed = await counts(assertions, rootSel);
  const attrs = await rootAttributes(rootSel);
  const chips = await chipReadout();
  const transcript = host === "chat_thread" ? await transcriptReadout() : null;
  const runSurface = host === "run_card" ? await runSurfaceReadout() : null;
  const theme = await page.evaluate(() => document.documentElement.className).catch(() => "");
  records.push(redact({
    cell,
    declaredHost: host,
    declaredKind: kind,
    declaredState,
    finalUrl: new URL(page.url()).pathname,
    screenshot: rel,
    sha256,
    assertions: observed,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: process.env.S9F_RUNTIME_NOTE ?? "",
    // THE PROVIDER-EVIDENCE BLOCK, on the record itself, so a reader grading this
    // cell can weigh its four readings directly. It does NOT identify which model
    // answered; no field in it can.
    providerEvidence,
    note,
    runId,
    dbAt,
    rootAttributes: attrs,
    chips,
    transcript,
    runSurface,
    themeClass: theme,
    framing: fullPage ? "page" : "window",
    viewport: { ...page.viewportSize(), deviceScaleFactor: 2 },
    pageErrors: [...pageErrors],
    ...extra,
  }));
  results.push(redact({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, transcript, runSurface, themeClass: theme, providerEvidence }));
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} turns=${transcript?.turns ?? "-"} chipRowInDetail=${runSurface?.chipRowInDetailColumn ?? "-"} progress=${runSurface?.agenticRunProgressHeadings ?? "-"}`);
  return dims;
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

/** GROW THE WINDOW until the named element fits between its top and bottom. */
async function fitTheWindow(sel) {
  for (let i = 0; i < 8; i += 1) {
    const box = await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, inner: window.innerHeight };
      }, sel)
      .catch(() => null);
    if (!box) return;
    if (box.top >= 0 && box.bottom <= box.inner) return;
    const grown = Math.min(2800, (page.viewportSize()?.height ?? VIEWPORT.height) + 300);
    if (grown === page.viewportSize()?.height) return;
    await page.setViewportSize({ width: VIEWPORT.width, height: grown });
    say(`WINDOW grown to ${VIEWPORT.width}x${grown} so ${sel} is in frame`);
    await page.waitForTimeout(1200);
  }
}

/** Scroll so the transcript's own top is in frame, then settle. */
async function frameTheTranscript() {
  await page.evaluate((listSel) => {
    const list = document.querySelector(listSel);
    if (!list) return;
    const scroller = list.closest("[data-conversation-scroll], main, div");
    list.scrollIntoView({ block: "start", behavior: "instant" });
    if (scroller && typeof scroller.scrollTop === "number") scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  }, CONVERSATION_LIST).catch(() => {});
  await page.waitForTimeout(1200);
  await fitTheWindow(CONVERSATION_LIST);
  await page.waitForTimeout(800);
}

/** The run page is its own surface: back to the declared window, top of page. */
async function frameTheRunSurface() {
  await page.setViewportSize({ ...VIEWPORT });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  await fitTheWindow(RUN_SURFACE);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
}

async function openRunPage(runId, pkg) {
  const [vendor, name] = String(pkg).replace(/^@/, "").split("/");
  const path = `/agents/${vendor}/${name}/${runId}`;
  await page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(RUN_SURFACE, { timeout: 600_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(9000);
  await frameTheRunSurface();
  return path;
}

async function openThread(threadPath) {
  await page.goto(`${APP}${threadPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(8000);
  await frameTheTranscript();
}
const state = {};

/** The slot the request is about, and the two readings it can hold. */
const SLOT = "[data-run-review-slot]";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const GATE_ROOT = '[data-lifecycle-card="artifact_review_gate"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
/** The removed link, by BOTH of its handles. Counted on every cell. */
const REMOVED_LINK = '[data-testid="inline-run-page-link"]';

const WORKING_ASSERTIONS_CHAT = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: INLINE_RUN_CARD, scope: "frame" },
  { selector: SLOT, scope: "frame" },
  { selector: PLACEHOLDER, scope: "frame" },
  { selector: "svg.animate-spin", scope: "root" },
  { selector: '[data-conformance-id="review-gate-loading"]', scope: "root" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: REMOVED_LINK, scope: "frame" },
];
const REVIEW_ASSERTIONS_CHAT = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: INLINE_RUN_CARD, scope: "frame" },
  { selector: SLOT, scope: "frame" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: REVIEW_CARD, scope: "frame" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "root" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: PLACEHOLDER, scope: "frame" },
  { selector: REMOVED_LINK, scope: "frame" },
];
const WORKING_ASSERTIONS_PAGE = [
  { selector: RUN_SURFACE, scope: "frame" },
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: SLOT, scope: "frame" },
  { selector: PLACEHOLDER, scope: "frame" },
  { selector: "svg.animate-spin", scope: "root" },
  { selector: '[data-conformance-id="review-gate-loading"]', scope: "root" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: REMOVED_LINK, scope: "frame" },
];
const REVIEW_ASSERTIONS_PAGE = [
  { selector: RUN_SURFACE, scope: "frame" },
  { selector: SLOT, scope: "frame" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: REVIEW_CARD, scope: "frame" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "root" },
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: PLACEHOLDER, scope: "frame" },
  { selector: REMOVED_LINK, scope: "frame" },
];

/** THE SLOT'S OWN READING, measured: which of the two the box is drawing, what
 *  the placeholder holds, and — on every cell — that the removed link is gone. */
const slotReadout = async () =>
  page
    .evaluate(
      ({ slotSel, phSel, gateSel, linkSel }) => {
        const slot = document.querySelector(slotSel);
        const ph = document.querySelector(phSel);
        const gate = document.querySelector(gateSel);
        const headings = [...document.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim());
        const bodyText = document.body.innerText;
        return {
          slotPresent: Boolean(slot),
          slotReading: slot?.getAttribute("data-run-review-slot") ?? null,
          placeholderPresent: Boolean(ph),
          placeholderSpinners: ph ? ph.querySelectorAll("svg.animate-spin").length : 0,
          placeholderEmptyReviewScreen: Boolean(
            ph?.querySelector('[data-conformance-id="review-gate-loading"]'),
          ),
          placeholderText: ph ? ph.innerText.trim() : null,
          reviewCardPresent: Boolean(gate),
          reviewCardInSlot: Boolean(slot && gate && slot.contains(gate)),
          reviewCardHost: gate?.getAttribute("data-lifecycle-card-host") ?? null,
          reviewCardState: gate?.getAttribute("data-lifecycle-card-state") ?? null,
          reviewRequestedHeadingPresent: bodyText.includes("Review requested"),
          agenticRunProgressHeadings: headings.filter((h) => h === "Agentic Run Progress").length,
          // THE REMOVED LINK, by both handles.
          removedLinkByTestId: document.querySelectorAll(linkSel).length,
          removedLinkByText: [...document.querySelectorAll("a")].filter(
            (a) => a.textContent.trim() === "Open the run page",
          ).length,
          runCompletionCards: document.querySelectorAll("[data-run-completion]").length,
        };
      },
      { slotSel: SLOT, phSel: PLACEHOLDER, gateSel: GATE_ROOT, linkSel: REMOVED_LINK },
    )
    .catch(() => null);

/** What the review card underneath is asking for, off its own decision bar. */
const gateReadout = async () =>
  page
    .evaluate((gateSel) => {
      const gate = document.querySelector(gateSel);
      if (!gate) return null;
      const bar =
        gate.querySelector('[data-conformance-id="review-decision-bar"]') ??
        document.querySelector('[data-conformance-id="review-decision-bar"]');
      return {
        state: gate.getAttribute("data-lifecycle-card-state"),
        host: gate.getAttribute("data-lifecycle-card-host"),
        decisionBar: Boolean(bar),
        decisionButtons: bar
          ? [...bar.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean)
          : [],
      };
    }, GATE_ROOT)
    .catch(() => null);

try {
  state.startedAt = new Date().toISOString();
  say(`# cinatra#2997 — the placeholder and the screen that replaces it — ${state.startedAt}`);
  say(`after sign-in: ${await signIn()}`);
  state.userId = (await q(`select id from public."user" where email = $1`, [ACTOR.email]))[0]?.id ?? null;
  state.evidenceAtStart = assertRealChain("sequence-start");
  evidenceBaseline = state.evidenceAtStart;

  // ---- the public ingress, proved before any pictured turn ----------------
  const publicOrigin = process.env.S9F_PUBLIC_ORIGIN ?? "";
  if (!publicOrigin) throw new Error("set S9F_PUBLIC_ORIGIN to this instance's public origin");
  const probe = async (url) => {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(20_000) });
      return { url, status: res.status, ms: Date.now() - t0 };
    } catch (e) {
      return { url, status: null, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const health = await fetch(`${publicOrigin}/api/health`).then((r) => r.status).catch(() => null);
  let mcpProbe = null;
  let streak = 0;
  for (let i = 0; i < 24 && streak < 3; i += 1) {
    mcpProbe = await probe(`${publicOrigin}/api/mcp`);
    say(`INGRESS probe ${i + 1}: ${JSON.stringify(mcpProbe)} streak=${streak}`);
    if (mcpProbe.status !== null && mcpProbe.ms < 1250) streak += 1;
    else streak = 0;
    if (streak < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  if (streak < 3) throw new Error(`the public MCP ingress never answered steadily (last probe ${JSON.stringify(mcpProbe)})`);
  if (health !== 200) throw new Error(`the public origin's /api/health answered ${health}, not 200`);
  await stamp("T0", "the public ingress answers, inside the app's own reachability budget", {
    publicOrigin: redact(publicOrigin),
    healthStatus: health,
    mcpHead: mcpProbe,
    consecutiveFastProbes: streak,
    budgetMs: 2500,
    requiredMs: 1250,
  });

  // ---- the person's turn that starts the run ------------------------------
  let sent = false;
  for (let attempt = 0; attempt < 5 && !sent; attempt += 1) {
    await page.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector(CHAT_PROMPT, { timeout: 300_000 });
    await page.waitForTimeout(9000);
    const composer = page.locator(CHAT_PROMPT).first();
    await composer.click();
    await composer.pressSequentially(MESSAGE, { delay: 4 });
    await page.waitForTimeout(1500);
    const typed = await composer.evaluate((el) => el.value ?? el.textContent ?? "").catch(() => "");
    if (!typed.includes(TURN_MARKER)) { say(`TURN attempt ${attempt + 1}: composer empty — retrying`); continue; }
    say(`TURN typed into the composer: ${MESSAGE}`);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(2000);
      const inTranscript = await page
        .evaluate(({ listSel, marker }) => (document.querySelector(listSel)?.innerText ?? "").includes(marker), { listSel: CONVERSATION_LIST, marker: TURN_MARKER })
        .catch(() => false);
      if (inTranscript) { sent = true; break; }
    }
    say(`TURN attempt ${attempt + 1}: in transcript = ${sent}`);
  }
  if (!sent) throw new Error("the turn never reached the transcript");
  say("TURN sent");

  // ---- the run card appears, and it NAMES ITS RUN --------------------------
  //
  // THE RECOMMENDATION HOLD IS NOT PART OF THIS CHAIN, and that is a fact about
  // this lane rather than a choice: no `lifecycle_continuation_park` row is
  // written for this run (the readout below records the count), so the hold the
  // earlier S3 chain walked never fires here and there are no chips to press.
  // What stands in the same place — the question the person answers before the
  // work starts — is the run's OWN required-input gate, which is answered below
  // through the card's own Continue. Neither is a subject of this request; what
  // it is about begins at the moment the work starts.
  await page.waitForSelector(INLINE_RUN_CARD, { timeout: 600_000 });
  await page.waitForTimeout(4000);
  state.threadPath = new URL(page.url()).pathname;
  await stamp("T1", "the run card is in the conversation", {
    evidence: readProviderEvidence(),
    threadPath: state.threadPath,
  });

  // ---- THE RUN ID, off the card's OWN name attribute -----------------------
  //
  // `data-inline-run-card="<runId>"` is the platform-built value the removed
  // link's href was built FROM, on the same card. It is the strong binding here.
  let named = null;
  for (let i = 0; i < 120 && !named; i += 1) {
    named = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-inline-run-card") ?? null, INLINE_RUN_CARD).catch(() => null);
    if (!named) await page.waitForTimeout(1000);
  }
  if (named) {
    state.runId = named;
    state.runIdSource = "the inline run card's own name attribute (data-inline-run-card)";
    state.runIdCandidates = 1;
  } else {
    const candidates = await q(`select id from cinatra.agent_runs where run_by = $1 and created_at >= $2 order by created_at desc`, [state.userId ?? null, state.startedAt]);
    state.runIdCandidates = candidates.length;
    if (candidates.length !== 1) throw new Error(`the run cannot be bound to this turn: ${candidates.length} candidate runs and the card named none`);
    state.runId = candidates[0].id;
    state.runIdSource = "the ONLY agent_runs row started by this actor since this sequence began";
  }
  const [tplRow] = await q(`select t.package_name from cinatra.agent_runs r join cinatra.agent_templates t on t.id = r.template_id where r.id=$1`, [state.runId]);
  state.packageName = String(tplRow?.package_name ?? "@cinatra-ai/blog-draft-writer-agent");
  say(`RUN ${state.runId} in thread ${state.threadPath} (${state.packageName})`);
  state.recommendationParkRows = (await q(`select count(*)::int as c from cinatra.lifecycle_continuation_park where run_id=$1`, [state.runId]))[0]?.c ?? null;
  say(`RECOMMENDATION PARK rows for this run: ${state.recommendationParkRows}`);

  // ---- the run's own gate, answered through the card's own Continue --------
  state.gatePresses = [];
  for (let i = 0; i < 60; i += 1) {
    const rows = await runRows(state.runId);
    if (rows.run?.status !== "pending_approval") break;
    const cont = page.getByRole("button", { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      let pressError = null;
      try { await cont.click({ timeout: 60_000 }); } catch (e) { pressError = e instanceof Error ? e.message : String(e); }
      state.gatePresses.push({ at: new Date().toISOString(), pressed: "Continue", landed: pressError === null, error: pressError });
      say(`GATE Continue ${pressError === null ? "pressed" : `FAILED (${pressError})`} (#${state.gatePresses.length})`);
      await page.waitForTimeout(6000);
      continue;
    }
    await page.waitForTimeout(3000);
  }

  const t2 = await runRows(state.runId);
  await stamp("T2", "the run's own question is answered and the work starts", {
    runStatus: t2.run?.status,
    recommendationParkRows: state.recommendationParkRows,
    gatePresses: state.gatePresses.length,
    selections: t2.selections,
    representationRows: t2.representations.length,
    reviewGateRows: t2.gates.length,
  });

  // =========================================================================
  // THE WORKING WINDOW — and why the RUN PAGE is shot FIRST.
  //
  // The placeholder stands for exactly as long as the run has work outstanding:
  // its own step, and then the produced output's review question while the
  // shipped sweeper is still answering it. On this lane that whole window is
  // about half a minute (the T2/T5 stamps carry both ends of it), and two
  // surfaces have to be photographed inside it. The run page is the one that
  // costs a navigation, so it goes first; the conversation is where the reader
  // already is, and it is shot second and then LEFT OPEN, so the replacement it
  // draws is a replacement under an open page rather than a fresh load.
  // =========================================================================
  const [vendor, name] = String(state.packageName).replace(/^@/, "").split("/");
  const runPath = `/agents/${vendor}/${name}/${state.runId}`;

  /** The lean framing the working cells use: top of the page, one settle. The
   *  full framing helpers grow the window and sleep for seconds, which is more
   *  than this window can spend. */
  const leanFrame = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(700);
  };

  // ---- R7a: the RUN PAGE, while the agent works ---------------------------
  await page.goto(`${APP}${runPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(RUN_SURFACE, { timeout: 600_000 });
  let sawWorkingPage = false;
  for (let i = 0; i < 40 && !sawWorkingPage; i += 1) {
    const r = await slotReadout();
    if (r?.slotReading === "working" && r.placeholderPresent) { sawWorkingPage = true; break; }
    if (r?.slotReading === "review") break;
    await page.waitForTimeout(500);
  }
  const pageWorkingRows = await runRows(state.runId);
  await stamp("T3", "the run panel on the RUN PAGE is the placeholder while the run works", {
    runStatus: pageWorkingRows.run?.status,
    representationRows: pageWorkingRows.representations.length,
    producedOutboxRows: pageWorkingRows.outbox.length,
    reviewGateRows: pageWorkingRows.gates.length,
    slot: await slotReadout(),
  });
  if (!sawWorkingPage) throw new Error("the working placeholder never drew on the run page — there is nothing to photograph for R7a");
  await leanFrame();
  await setTheme("cinatra");
  await shoot("R7a__review-placeholder__run_card__working", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "working",
    rootSel: PLACEHOLDER, assertions: WORKING_ASSERTIONS_PAGE, runId: state.runId, dbAt: timeline.at(-1),
    note: "THE PLACEHOLDER, ON THE RUN PAGE — the request's \u2018on the run page, the same is true\u2019. The run panel is the card, the design system\u2019s spinner and the empty review screen, and nothing else. The run\u2019s own rows at this instant are on the record: the review question its output raises has not been answered yet, which is what the placeholder is standing for.",
    extra: { slot: await slotReadout(), runSurface: await runSurfaceReadout() },
  });
  await setTheme("dark");
  await shoot("R7a__review-placeholder__run_card__working__dark", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "working",
    rootSel: PLACEHOLDER, assertions: WORKING_ASSERTIONS_PAGE, runId: state.runId, dbAt: timeline.at(-1),
    note: "The same run page, the same working placeholder, in the dark palette.",
    extra: { slot: await slotReadout(), runSurface: await runSurfaceReadout() },
  });
  await setTheme("cinatra");

  // ---- S3a: the CHAT, while the agent works -------------------------------
  await page.goto(`${APP}${state.threadPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CONVERSATION_LIST, { timeout: 600_000 });
  let sawWorking = false;
  for (let i = 0; i < 40 && !sawWorking; i += 1) {
    const r = await slotReadout();
    if (r?.slotReading === "working" && r.placeholderPresent) { sawWorking = true; break; }
    if (r?.slotReading === "review") break;
    await page.waitForTimeout(500);
  }
  const workingRows = await runRows(state.runId);
  await stamp("T4", "the card in the conversation is the PLACEHOLDER while the run works", {
    runStatus: workingRows.run?.status,
    representationRows: workingRows.representations.length,
    producedOutboxRows: workingRows.outbox.length,
    reviewGateRows: workingRows.gates.length,
    slot: await slotReadout(),
  });
  if (!sawWorking) throw new Error("the working placeholder never drew in the conversation — there is nothing to photograph for S3a");
  await leanFrame();
  await setTheme("cinatra");
  await shoot("S5a__review-placeholder__run_card__in-conversation__working", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "working",
    rootSel: PLACEHOLDER, assertions: WORKING_ASSERTIONS_CHAT, runId: state.runId, dbAt: timeline.at(-1),
    note: "THE PLACEHOLDER, in the conversation, while the agent works. The card is the frame, the design system\u2019s spinner and the empty review screen, and it says nothing else \u2014 no heading, no status word, no transcript. The removed link is counted here and on every other cell in this set, by its test id and by its label text, and both are ZERO.",
    extra: { slot: await slotReadout() },
  });
  await setTheme("dark");
  await shoot("S5a__review-placeholder__run_card__in-conversation__working__dark", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "working",
    rootSel: PLACEHOLDER, assertions: WORKING_ASSERTIONS_CHAT, runId: state.runId, dbAt: timeline.at(-1),
    note: "The same window, the same working placeholder in the same conversation, in the dark palette.",
    extra: { slot: await slotReadout() },
  });
  await setTheme("cinatra");

  // ---- the run runs, and the sweeper opens the review ----------------------
  state.runStatusWalk = [];
  let lastStatus = null;
  for (let i = 0; i < 120; i += 1) {
    const rows = await runRows(state.runId);
    if (rows.run?.status && rows.run.status !== lastStatus) {
      state.runStatusWalk.push({ at: new Date().toISOString(), status: rows.run.status });
      say(`RUN STATUS -> ${rows.run.status}`);
      lastStatus = rows.run.status;
    }
    if (rows.gates.length > 0) { say(`REVIEW GATE opened after ~${i * 5}s`); break; }
    if (rows.run?.status === "failed") { say(`RUN FAILED: ${rows.run.error}`); break; }
    await page.waitForTimeout(5000);
  }
  const t5 = await runRows(state.runId);
  await stamp("T5", "the step ran, the run wrote its own output, and the sweeper opened the review", {
    evidence: readProviderEvidence(),
    runStatus: t5.run?.status,
    runCompletedAt: t5.run?.completed_at,
    runError: t5.run?.error,
    representations: t5.representations,
    outbox: t5.outbox,
    gates: t5.gates,
  });
  state.reviewTaskId = t5.gates[0]?.review_task_id ?? null;
  state.gateCreatedAt = t5.gates[0]?.created_at ?? null;
  if (t5.representations.length === 0) throw new Error("the run produced no representation row — there is no output for a review to open on");
  if (!state.reviewTaskId) throw new Error("no artifact_review_gates row for this run — there is no review to photograph");

  // =========================================================================
  // S3 — THE REPLACEMENT, IN THE CONVERSATION, UNDER AN OPEN PAGE.
  // The chat has been open since S3a. It is NOT reloaded here: what is
  // photographed is the swap the card makes by itself, and no turn is typed.
  // =========================================================================
  let chatSwapped = false;
  for (let i = 0; i < 120 && !chatSwapped; i += 1) {
    const r = await slotReadout();
    if (r?.slotReading === "review" && r.reviewCardInSlot) { chatSwapped = true; break; }
    await page.waitForTimeout(2000);
  }
  state.chatSwappedWithoutReload = chatSwapped;
  await frameTheTranscript();
  const transcriptNow = await transcriptReadout();
  state.turnsAtReview = transcriptNow?.turns ?? null;
  await stamp("T6", "the conversation's own card is now the review screen", {
    turns: state.turnsAtReview,
    swappedWithoutReload: chatSwapped,
    gateStatus: t5.gates[0]?.status,
    gateCreatedAt: state.gateCreatedAt,
    slot: await slotReadout(),
  });
  if (!chatSwapped) throw new Error("the conversation's run card never became the review screen");
  await setTheme("cinatra");
  await shoot("S5__review-card__run_card__in-conversation__pending", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "pending",
    rootSel: GATE_ROOT, assertions: REVIEW_ASSERTIONS_CHAT, runId: state.runId, dbAt: timeline.at(-1),
    note: "THE REPLACEMENT, IN THE CONVERSATION, and the picture this cell now stands for. The card that was the placeholder in S3a is the \u2018Review requested\u2019 screen \u2014 same slot, same conversation, Comment / Reject / Approve on it. The page was NOT reloaded between the two (`chatSwappedWithoutReload` on the sequence state) and NOTHING was typed after the run\u2019s own question was answered: the transcript\u2019s turn count is on the record. The previous version of this cell showed the opposite reading, which is what the request for changes was about: a finished run announcing \u2018Run complete\u2019, a question typed by the person, and only then a review card.",
    extra: { slot: await slotReadout(), gate: await gateReadout() },
  });
  await setTheme("dark");
  await shoot("S5__review-card__run_card__in-conversation__pending__dark", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "pending",
    rootSel: GATE_ROOT, assertions: REVIEW_ASSERTIONS_CHAT, runId: state.runId, dbAt: timeline.at(-1),
    note: "The same window, the same replaced slot in the same conversation, in the dark palette.",
    extra: { slot: await slotReadout(), gate: await gateReadout() },
  });
  await setTheme("cinatra");

  // =========================================================================
  // R7 — THE SAME REPLACEMENT ON THE RUN PAGE. This one IS a fresh load of the
  // run page, and the record says so: the in-place claim is carried by S3,
  // on the surface the request pictures.
  // =========================================================================
  await page.goto(`${APP}${runPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(RUN_SURFACE, { timeout: 600_000 });
  let pageSwapped = false;
  for (let i = 0; i < 60 && !pageSwapped; i += 1) {
    const r = await slotReadout();
    if (r?.slotReading === "review" && r.reviewCardInSlot) { pageSwapped = true; break; }
    await page.waitForTimeout(2000);
  }
  await frameTheRunSurface();
  await stamp("T7", "the run page's own slot holds the review screen", { slot: await slotReadout() });
  if (!pageSwapped) throw new Error("the run page's slot never became the review screen");
  await setTheme("cinatra");
  await shoot("R7__review-card__run_card__pending", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "pending",
    rootSel: GATE_ROOT, assertions: REVIEW_ASSERTIONS_PAGE, runId: state.runId, dbAt: timeline.at(-1),
    note: "THE REPLACEMENT, ON THE RUN PAGE. The panel that was the placeholder in R7a now holds the \u2018Review requested\u2019 screen with Comment / Reject / Approve, on the run_card host \u2014 the same reading as the conversation, on the same run, minutes apart. This cell is shot on a fresh load of the run page; the under-an-open-page claim is S3\u2019s.",
    extra: { slot: await slotReadout(), gate: await gateReadout(), runSurface: await runSurfaceReadout() },
  });
  await setTheme("dark");
  await shoot("R7__review-card__run_card__pending__dark", {
    host: "run_card", kind: "artifact_review_gate", declaredState: "pending",
    rootSel: GATE_ROOT, assertions: REVIEW_ASSERTIONS_PAGE, runId: state.runId, dbAt: timeline.at(-1),
    note: "The same run page, the same replaced slot, in the dark palette.",
    extra: { slot: await slotReadout(), gate: await gateReadout(), runSurface: await runSurfaceReadout() },
  });
  await setTheme("cinatra");
  say("SEQUENCE OK");
} catch (e) {
  say(`SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "sequence-state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
  writeFileSync(join(OUT, "capture-records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, pageErrors }, null, 2));
  writeFileSync(join(OUT, "sequence.log"), log.join("\n") + "\n");
  await browser.close();
  await client.end();
}
