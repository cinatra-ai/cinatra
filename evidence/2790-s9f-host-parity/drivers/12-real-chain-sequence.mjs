// ---------------------------------------------------------------------------
// cinatra#2790 S9f (PR #2890 re-shoot) — THE FOUR CELLS, WITH BOTH STOOD-IN
// LEGS REMOVED.
//
// WHY THIS FILE EXISTS. The committed S1/S2/R5/R6 records were shot on a chain
// with two stood-in legs, and both are now banned outright:
//
//   · THE CHAT TURN took the deterministic pre-router. The turn named the agent
//     package and carried embedded `inputParams`, so `detectExplicitDispatchPackage`
//     matched and the server dispatched the run ITSELF — no model was consulted
//     for the turn at all.
//   · THE AGENT'S OWN STEP was served by the SCRIPTED runtime. The real provider
//     row was removed mid-sequence because this instance had no public MCP
//     ingress and the provider's toolbox fetch answered 424.
//
// NEITHER HAPPENS HERE, and neither can:
//
//   · THE TURN IS NATURAL LANGUAGE and names NO package token. It matches no
//     branch of the pre-router, so the only thing that can start a run from it
//     is the REAL MODEL calling `agent_run` through this instance's own public
//     MCP toolbox. The run is a chat launch because the TRANSPORT says so
//     (`delegatedRestricted`, stamped from the verified `delegation: "chat"`
//     actor), which is the same server-stamped carrier the pre-router path
//     used — so the hold fires for the same reason it did before, from a frame
//     the model cannot forge.
//   · THE SEALED `openai_connection` ROW STAYS FOR THE WHOLE SEQUENCE. There is
//     no provider window and no `PROVIDER_CLEAR` step in this file. The public
//     origin is set through the app's own tunnel surface before the run, so the
//     provider CAN fetch the toolbox it 424'd on last time.
//   · `CINATRA_TEST_LLM_PROVIDER` IS UNSET, and this driver REFUSES TO START if
//     it is set. The scripted runtime is not merely unused here — it is
//     unreachable by construction (`isScriptedTestProviderEnabled` reads that
//     one env var), so no leg of this chain can fall back to it.
//
// WHAT IS MEASURED ABOUT THAT, rather than asserted: the driver reads the app
// server's OWN log across the whole sequence and records, on every cell,
//
//   · `preRouterShortCircuits` — the deterministic chat dispatch. MUST be 0.
//   · `scriptedRuntimeLines` — any scripted-provider line. MUST be 0.
//   · `publicMcpCallbacks` — `POST /api/mcp` hits. These are the hosted provider
//     calling BACK into this instance over the public origin; nothing else in
//     this lane produces them, so a non-zero count is positive evidence that a
//     real provider loaded and used the public toolbox.
//   · `noProviderRefusals` — `NO_LLM_PROVIDER` / 503 on the bridge. MUST be 0.
//   · `mcpDependencyFailures` — the 424 that killed the previous attempt. MUST be 0.
//
// A run that reaches a pictured state with any of the three MUST-be-0 counters
// non-zero ABORTS the sequence rather than photographing it.
//
// EVERYTHING ELSE IS THE 09 SEQUENCE, DELIBERATELY UNCHANGED: the same four
// states in the same order (chat HELD, run page HELD, chat DECIDED, run page
// DECIDED), light and dark; the same full-window shutter at 1440x1700 CSS px,
// deviceScaleFactor 2, with no crop and no `fullPage` stitch; the same reload
// before every picture so each cell is the DURABLE state; the same
// recorder-measured assertion sets; and the same rule that every lifecycle
// timestamp is read from a database column while capture/press times are this
// process's clock.
//
// Real presses only. The four chips are decided one at a time through the
// card's own per-chip controls; the run's own in-flight gate is answered by its
// own Continue; nothing else is pressed and nothing is stood in for.
//
// No origin is hard-coded: the app origin and the lane database are read from
// the environment.
//
// A NOTE ON ONE STRING. The banner this file prints at the start of a run still
// reads "the FULLY-REAL chat + run-page sequence". That wording is kept VERBATIM
// rather than tidied, because `logs/realchain-sequence.txt` is the recorded run's
// own output and a re-run must reproduce it byte for byte. What the evidence does
// and does not establish is written in README.md, RUN-READBACK.md and
// PLAN-WALK.md, and those are the documents that carry the claim.
//
// Usage: node 12-real-chain-sequence.mjs <appOrigin> <outDir> <repoRoot>
//        env: S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, S9F_SERVER_LOG,
//             S9F_RUNTIME_NOTE
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
    "usage: 12-real-chain-sequence.mjs <appOrigin> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, S9F_SERVER_LOG",
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

// THE SCRIPTED RUNTIME IS NOT MERELY UNUSED HERE — IT IS REFUSED. Its only
// activation switch is this one env var; a sequence that ran with it set could
// not honestly claim any leg was real, so the driver stops before it starts.
if (process.env.CINATRA_TEST_LLM_PROVIDER) {
  throw new Error(
    `CINATRA_TEST_LLM_PROVIDER is set (${process.env.CINATRA_TEST_LLM_PROVIDER}) — this sequence refuses to run a chain that can reach the scripted runtime`,
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
 * So the ONLY thing in this system that can turn this turn into a run is the
 * model, calling the platform's own `agent_run` through the public MCP toolbox.
 * That is the whole point of the re-shoot.
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
 *   publicMcpCallbacks      `POST /api/mcp` — the hosted provider calling BACK
 *                           into this instance over the public origin.
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
 * The claim that the chain is real does NOT rest on them. It rests on the
 * structural facts beside them: the app server's own environment (the scripted
 * runtime's single switch), the sealed provider row read before AND after the
 * step, and the hosted provider's own calls back into this instance.
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
  //   serverScriptedProviderEnv — the value in the ENVIRONMENT OF THE RUNNING
  //                               APP SERVER, read from the process table by pid
  //                               (`ps eww`). This is the one that decides
  //                               whether the scripted runtime is reachable at
  //                               all, and it is the load-bearing measurement.
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
 * Read `CINATRA_TEST_LLM_PROVIDER` out of the running app server's PROCESS CHAIN.
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
 * decisive fact: `resolveConfiguredLlmRuntime` reaches the scripted runtime only
 * as a LAST RESORT and never with a configured provider, and rows `T1c`/`T3a`
 * read that provider back on both sides of the step.
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
 *   · the APP SERVER's own `CINATRA_TEST_LLM_PROVIDER` is absent, and was
 *     actually READ rather than merely unavailable — an unread value is a
 *     failure here, not a pass;
 *   · once the sequence is under way, the POSITIVE counter must have MOVED: a
 *     hosted provider that never called back into this instance would leave
 *     `publicMcpCallbacks` flat, and the sequence would then be photographing a
 *     state nothing external produced.
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
      `the app server has CINATRA_TEST_LLM_PROVIDER=${ev.serverScriptedProviderEnv} — the scripted runtime is reachable and this sequence refuses to photograph it`,
    );
  }
  if (ev.serverEnvReadFrom !== "process-table") {
    throw new Error(
      `the app server's environment could not be read (${ev.serverEnvReadFrom}) — an unread switch is not an absent one`,
    );
  }
  if (requireMovement && !(ev.deltaSinceStart?.publicMcpCallbacks > 0)) {
    throw new Error(
      `no hosted-provider callback reached this instance during the sequence (publicMcpCallbacks delta ${ev.deltaSinceStart?.publicMcpCallbacks}) — nothing external produced these states`,
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
async function shoot(cell, { host, kind, declaredState, rootSel, assertions, note, runId, dbAt, extra = {} }) {
  // THE GATE BEFORE THE SHUTTER. Read the server's own log and refuse to
  // photograph a state a stood-in leg produced. It throws rather than warns:
  // the sequence's whole claim is that no such leg exists.
  const providerEvidence = assertRealChain(cell, { requireMovement: true });
  await stripDevOverlay();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  await page.screenshot({ path: abs, scale: "device" });
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
    // THE PROVIDER-EVIDENCE BLOCK, on the record itself, so a reader grading
    // this cell never has to take the prose's word for which model answered.
    providerEvidence,
    note,
    runId,
    dbAt,
    rootAttributes: attrs,
    chips,
    transcript,
    runSurface,
    themeClass: theme,
    framing: "window",
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
try {
  state.startedAt = new Date().toISOString();
  say(`# cinatra#2790 S9f — the FULLY-REAL chat + run-page sequence — ${state.startedAt}`);
  say(`after sign-in: ${await signIn()}`);
  state.userId =
    (await q(`select id from public."user" where email = $1`, [ACTOR.email]))[0]?.id ?? null;
  // The evidence baseline, before a single turn is typed.
  state.evidenceAtStart = assertRealChain("sequence-start");
  evidenceBaseline = state.evidenceAtStart;

  // ---- THE PUBLIC INGRESS, PROVED BEFORE ANY PICTURED TURN ----------------
  //
  // The app's own dead-ingress guard (#1699) probes the public MCP URL with a
  // HEAD and a 2.5s budget, and REFUSES the turn if it does not answer in time.
  // On a dev server that budget is not a statement about the tunnel: the first
  // request to a route that has never been compiled pays the compile, which is
  // measured here in seconds. So the ingress is exercised for real, through the
  // real public origin, until it answers INSIDE the app's own budget — and the
  // measurement is written down rather than assumed.
  //
  // This warms nothing the pictures depend on and stands in for nothing: it is
  // the same HEAD the server itself will make, made from here first.
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
  for (let i = 0; i < 12; i += 1) {
    mcpProbe = await probe(`${publicOrigin}/api/mcp`);
    say(`INGRESS probe ${i + 1}: ${JSON.stringify(mcpProbe)}`);
    // The app's own budget, quoted from `MCP_REACHABILITY_TIMEOUT_MS`.
    if (mcpProbe.status !== null && mcpProbe.ms < 2500) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (health !== 200) throw new Error(`the public origin's /api/health answered ${health}, not 200`);
  if (!mcpProbe || mcpProbe.status === null || mcpProbe.ms >= 2500) {
    throw new Error(`the public MCP ingress never answered inside the app's own 2500ms budget: ${JSON.stringify(mcpProbe)}`);
  }
  await stamp("T0", "the public ingress answers, inside the app's own reachability budget", {
    publicOrigin: redact(publicOrigin),
    healthStatus: health,
    mcpHead: mcpProbe,
    budgetMs: 2500,
  });

  // ---- the person's turn that starts the run ------------------------------
  // TYPED, READ BACK, AND CONFIRMED SENT. A composer that re-mounts under the
  // /chat -> /chat/<vendor>/<assistant>/<thread> redirect silently drops what was
  // typed into the previous mount, and an Enter on an empty composer is a no-op
  // that looks exactly like a successful turn. So the text is read back before
  // Enter, and the turn is only called sent once it is IN the transcript.
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
    if (!typed.includes(TURN_MARKER)) {
      say(`TURN attempt ${attempt + 1}: the composer did not hold the text — retrying`);
      continue;
    }
    say(`TURN typed into the composer: ${MESSAGE}`);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(2000);
      const inTranscript = await page
        .evaluate(
          ({ listSel, marker }) => (document.querySelector(listSel)?.innerText ?? "").includes(marker),
          { listSel: CONVERSATION_LIST, marker: TURN_MARKER },
        )
        .catch(() => false);
      if (inTranscript) {
        sent = true;
        break;
      }
    }
    say(`TURN attempt ${attempt + 1}: in transcript = ${sent}`);
  }
  if (!sent) throw new Error("the turn never reached the transcript");
  say("TURN sent");

  // ---- the run parks at the recommendation hold ---------------------------
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    if (st === "held") break;
    await page.waitForTimeout(2000);
  }
  state.threadPath = new URL(page.url()).pathname;
  // THE RUN ID COMES OFF THE PAGE, from the inline run panel's own link out —
  // the platform builds that href from the run id, so it names the run THIS
  // turn dispatched rather than "whatever ran last".
  const linked = await page
    .evaluate(() => {
      const a = document.querySelector('[data-testid="inline-run-page-link"]');
      const href = a?.getAttribute("href") ?? "";
      const m = href.match(/([0-9a-fA-F-]{36})$/);
      return m ? m[1] : null;
    })
    .catch(() => null);
  // THE FALLBACK IS NARROWED, not just ordered: the newest run STARTED BY THIS
  // ACTOR SINCE THIS SEQUENCE BEGAN. The 09 fallback took the newest row in the
  // whole database, which a concurrent run on the same lane would have won.
  // THE FALLBACK IS NARROWED **AND** UNAMBIGUOUS. The 09 fallback took the newest
  // row in the whole database, which a concurrent run would have won. This one
  // asks for every run started BY THIS ACTOR SINCE THIS SEQUENCE BEGAN and
  // REFUSES unless there is exactly one: two candidates mean the binding cannot
  // say which run the pictures are of, and a binding that cannot say that is not
  // a binding. The count is recorded either way.
  if (linked) {
    state.runId = linked;
    state.runIdSource = "inline-run-page-link";
    state.runIdCandidates = 1;
  } else {
    const candidates = await q(
      `select id from cinatra.agent_runs where run_by = $1 and created_at >= $2 order by created_at desc`,
      [state.userId ?? null, state.startedAt],
    );
    state.runIdCandidates = candidates.length;
    if (candidates.length !== 1) {
      throw new Error(
        `the run cannot be bound to this turn: ${candidates.length} runs were started by this actor since the sequence began, and the inline run-page link did not resolve`,
      );
    }
    state.runId = candidates[0].id;
    state.runIdSource = "the ONLY agent_runs row started by this actor since this sequence began";
  }
  // WHICH BINDING ANSWERED IS WRITTEN DOWN, and so is how strong it is. The
  // link-out is the strong one (the platform builds that href from THIS turn's
  // run id). The fallback above is weaker but no longer loose: it is the set of
  // runs this actor started since the sequence began, and it is accepted ONLY
  // when that set holds exactly one row — `runIdCandidates` records the count and
  // the driver throws on anything else. Do not look for a run id in the S1
  // transcript: a turn with no package token produces no synthesized dispatch
  // line, so the picture carries no id to cross-check. `finalUrl` on the two R6
  // records is the run page for this exact id, and `dbAt` on S1 is the park read
  // for it; those are the checks a reader has.
  const [tplRow] = await q(
    `select t.package_name from cinatra.agent_runs r join cinatra.agent_templates t on t.id = r.template_id where r.id=$1`,
    [state.runId],
  );
  state.packageName = String(tplRow?.package_name ?? "@cinatra-ai/blog-draft-writer-agent");
  say(`RUN ${state.runId} in thread ${state.threadPath} (${state.packageName})`);

  // RELOAD, so what is photographed is the DURABLE state of this conversation.
  await openThread(state.threadPath);

  const t1 = await runRows(state.runId);
  await stamp("T1", "held at the recommendation hold; the run has produced NOTHING", {
    // The turn's own evidence, read before the first shutter: the pre-router
    // never fired, so the model is what turned this sentence into a run.
    evidence: readProviderEvidence(),
    runStatus: t1.run?.status,
    humanPresent: t1.run?.human_present,
    parkCheckpoint: t1.park[0]?.checkpoint,
    parkStatus: t1.park[0]?.status,
    parkCreatedAt: t1.park[0]?.created_at,
    representationRows: t1.representations.length,
    producedOutboxRows: t1.outbox.length,
    reviewGateRows: t1.gates.length,
    selectionRows: t1.selections.length,
  });
  if (t1.representations.length !== 0 || t1.outbox.length !== 0 || t1.gates.length !== 0) {
    throw new Error("S1 precondition broken: the run already has output rows");
  }

  // ---- S1: the chat, HELD --------------------------------------------------
  await setTheme("cinatra");
  await shoot("S1__recommendation-card__chat_thread__held", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: CHAT_HELD_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The whole conversation in one browser window: the person's own turn — plain English, naming no package and carrying no inputParams — and the assistant's own reply carrying the recommendation card HELD. One chip per skill, each with its own Confirm / Adjust / Skip; no heading plate, no row-level submit. NO agentic run progress card is anywhere in the turn: the skills are still being chosen, so the run has not started and the run-card count reads ZERO. Nothing has been produced either — representation, produced-outbox and review-gate rows for this run all read ZERO in the database at this instant (dbAt). The chain that produced this state is real end to end, and the record's own `providerEvidence` block is where that is read: the deterministic pre-router never fired (`preRouterShortCircuits: 0`), no scripted-runtime line exists in the server log, and the hosted provider called back into this instance over its public origin.",
  });
  await setTheme("dark");
  await shoot("S1__recommendation-card__chat_thread__held__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: CHAT_HELD_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same window and the same held turn in the dark palette — chip row present, no run progress card, same real chain and the same `providerEvidence` counters.",
  });
  await setTheme("cinatra");

  // ---- R5: the RUN PAGE for the same run, still HELD ----------------------
  state.runPath = await openRunPage(state.runId, state.packageName);
  const t1b = await runRows(state.runId);
  await stamp("T1b", "the run page is opened while the SAME hold is still parked", {
    runStatus: t1b.run?.status,
    parkStatus: t1b.park[0]?.status,
    selectionRows: t1b.selections.length,
    representationRows: t1b.representations.length,
    url: state.runPath,
  });
  if (t1b.park[0]?.status !== "parked") {
    throw new Error("R5 precondition broken: the hold is no longer parked");
  }
  await shoot("R5__recommendation-card__run_card__held", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The run page for the SAME run — the one the model started from the conversation — while the recommendation is still held: the two-column frame, the step rail down the LEFT with `Recommendation` at the trigger position, and the chip row as that step's own surface in the run detail on the RIGHT. Nothing is drawn inline under the rail row (the chip row is a descendant of the run-detail column, not of the rail column and not of the row), and there is no Agentic Run Progress section beside a run that has not run. A held run contributes no work steps of its own, so what the rail carries here is the gate row alone — stated, not glossed.",
  });
  await setTheme("dark");
  await shoot("R5__recommendation-card__run_card__held__dark", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same run page and the same held state in the dark palette — the gate row alone on the rail, the chips in the run detail beside it.",
  });
  await setTheme("cinatra");

  // ---- THE PROVIDER STAYS ------------------------------------------------
  //
  // The 09 sequence removed the real `openai_connection` row at exactly this
  // point, because the provider could not fetch this instance's toolbox and the
  // step's model call had to be served by the scripted runtime instead. THAT
  // STEP IS GONE. Nothing is cleared, nothing is swapped, and the same sealed
  // row the run was created under serves every model call still ahead of it.
  //
  // What replaces it is a READ, through the shipped reader, recorded as its own
  // timeline row: the row is still there, and it is still a real key rather than
  // the presence placeholder an earlier round used.
  const providerReadOut = execFileSync(
    "npx",
    [
      "vitest",
      "run",
      "--config",
      "evidence/2790-s9f-host-parity/drivers/08-real-provider.config.ts",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, WALK_STEP: "PROVIDER_READ" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const providerLine = providerReadOut.split("\n").find((l) => l.includes("S9FREAL PROVIDER_READ")) ?? "";
  await stamp(
    "T1c",
    "the REAL sealed provider row is STILL configured — nothing was cleared and no scripted runtime is reachable",
    { shippedReader: "readOpenAIConnection", readBack: providerLine.trim(), evidence: readProviderEvidence() },
  );

  // ---- the decision, chip by chip, IN THE CHAT -----------------------------
  await openThread(state.threadPath);
  const held = await chipReadout();
  state.heldChips = held;
  state.decisionPresses = [];
  for (let i = 0; i < held.length; i += 1) {
    const skillId = held[i].skillId;
    const action = DECISION_ORDER[i % DECISION_ORDER.length];
    await page
      .locator(`${CARD_ROOT} ${CHIP}[data-skill-id="${skillId}"] [data-skill-action="${action}"]`)
      .first()
      .click({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    if (action === "adjust") {
      await page.locator('[data-skill-action="adjust-keep"]').first().click({ timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
    const after = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    state.decisionPresses.push({ skillId, action, cardStateAfter: after, at: new Date().toISOString() });
    say(`PRESS ${action} on ${skillId} -> card state ${after}`);
  }
  await page.waitForTimeout(12_000);

  // RELOAD again — the settled row must survive a reload to be durable state.
  await openThread(state.threadPath);

  const t2 = await runRows(state.runId);
  await stamp("T2", "the decisions are written and the hold is RELEASED", {
    runStatus: t2.run?.status,
    parkStatus: t2.park[0]?.status,
    parkResolvedAt: t2.park[0]?.resolved_at,
    selections: t2.selections,
    representationRows: t2.representations.length,
    reviewGateRows: t2.gates.length,
  });

  // ---- S2: the chat, DECIDED ----------------------------------------------
  await shoot("S2__recommendation-card__chat_thread__decided", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: CHAT_DECIDED_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The same conversation and the same slot after the person decided every chip in the chat, through the card's own per-chip controls. The row SETTLED IN PLACE: same reply, same position, each chip stating its own outcome, nothing left to press. The agentic run progress card is now on screen — it appears with the decision, not before it — and there is NO skills button row inside it (the picker count reads ZERO). The hold reads released in the database at this instant, and the sealed real provider is still the configured one (timeline row T1c).",
  });
  await setTheme("dark");
  await shoot("S2__recommendation-card__chat_thread__decided__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: CHAT_DECIDED_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same settled turn in the dark palette — settled chips, the run progress card, and no skills button row inside it.",
  });
  await setTheme("cinatra");

  // ---- the run runs -------------------------------------------------------
  //
  // The run was created with a real sealed provider row configured, that row is
  // STILL configured (T1c above reads it back), and the scripted runtime is
  // unreachable in this process. So every model call this loop waits on goes to
  // the real provider through the public toolbox — and the evidence counters
  // stamped on T3 are where that is read rather than asserted.
  state.gatePresses = [];
  state.runStatusWalk = [];
  let lastStatus = null;
  for (let i = 0; i < 90; i += 1) {
    const rows = await runRows(state.runId);
    // WALK THE RUN'S OWN STATES, and RELOAD when it moves.
    //
    // A real run does not have one gate: it has however many its own shape asks
    // for, and which ones appear depends on what the model handed `agent_run`.
    // Measured on this lane across three real runs: a dispatch carrying complete
    // inputs walks straight to the runtime's own gate, while one that does not
    // parks first on the agent's setup field and then on its trigger step.
    //
    // The card in the conversation is a live component; once a press moves the
    // run, the control still on screen belongs to the step that is already over,
    // and pressing it again is answered — correctly — with a refusal. So the
    // page is RE-OPENED whenever the run's status changes, and what is pressed
    // next is the control the CURRENT step draws. Nothing is stood in for; this
    // only stops the loop from arguing with a card it has not re-read.
    if (rows.run?.status && rows.run.status !== lastStatus) {
      state.runStatusWalk.push({ at: new Date().toISOString(), status: rows.run.status });
      say(`RUN STATUS -> ${rows.run.status}`);
      if (lastStatus !== null) await openThread(state.threadPath);
      lastStatus = rows.run.status;
      // A RUN THAT PARKS ON ITS TRIGGER CANNOT ANSWER R6, AND SAYS SO AT ONCE.
      //
      // `pending_trigger` is a real state a real dispatch can reach — measured on
      // this lane when the model hands `agent_run` no `inputParams`, so the run
      // parks on the agent's setup field first and on its trigger after. Neither
      // surface on this branch draws a control for that state (the schedule card
      // in the conversation is the slice cinatra#2788 adds, and the run page's
      // Setup tab keeps showing the setup field), so the run stops there.
      //
      // R6 owes the DECIDED run page of a run that RAN. This sequence therefore
      // refuses to photograph one that did not, and fails LOUD and early rather
      // than looping until the gate budget expires and then shooting the wrong
      // state. The correct response is to run the sequence again; nothing here is
      // retried in place and no state is faked forward.
      if (rows.run.status === "pending_trigger") {
        throw new Error(
          "the run parked on its trigger (pending_trigger) — this dispatch carried no inputParams, so the run never executes and R6 has nothing decided-and-run to photograph; re-run the sequence",
        );
      }
    }
    if (rows.gates.length > 0) {
      say(`REVIEW GATE opened after ~${i * 10}s`);
      break;
    }
    if (rows.run?.status === "completed" && rows.representations.length > 0) {
      say(`RUN COMPLETED with ${rows.representations.length} representation row(s)`);
      break;
    }
    const cont = page.getByRole("button", { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      // THE AGENT'S OWN REQUIRED INPUT, ANSWERED BY THE PERSON.
      //
      // On a REAL chain the model decides for itself how much of the request to
      // hand `agent_run` as `inputParams`. When it hands over everything, the run
      // walks straight to its own gate; when it does not, the run parks on the
      // agent's own setup field and asks — which is exactly what the plan says
      // happens next ("the run card shows that agent's own required field or
      // fields as plain text controls with Continue"), and pressing Continue on
      // an empty one is a no-op that looks like a stuck run.
      //
      // So the field is FILLED, the way the person who asked would fill it: with
      // the idea from their own turn, in the shape the field's own help text
      // asks for. Nothing is stood in for — this is a real press on a real
      // control, and it is recorded beside the gate presses.
      const field = page.locator("[id^='field-']").first();
      if ((await field.count().catch(() => 0)) && !(await field.inputValue().catch(() => "x"))) {
        await field.click({ timeout: 60_000 });
        await field.fill(JSON.stringify(IDEA));
        await page.waitForTimeout(800);
        state.inputFills = state.inputFills ?? [];
        state.inputFills.push({
          at: new Date().toISOString(),
          fieldId: await field.getAttribute("id"),
          readBack: await field.inputValue().catch(() => null),
        });
        say(`INPUT filled the run's own required field (#${state.inputFills.length})`);
      }
      // RECORD WHAT HAPPENED, not what was attempted: a swallowed click that
      // still writes "pressed" is a fabricated press. The outcome rides on the
      // row either way, so a failed attempt is visible instead of invisible.
      let pressError = null;
      try {
        await cont.click({ timeout: 60_000 });
      } catch (e) {
        pressError = e instanceof Error ? e.message : String(e);
      }
      state.gatePresses.push({
        at: new Date().toISOString(),
        pressed: "Continue",
        landed: pressError === null,
        error: pressError,
      });
      say(`GATE Continue ${pressError === null ? "pressed" : `FAILED (${pressError})`} (#${state.gatePresses.length})`);
      // A FAILED GATE PRESS ABORTS THE SEQUENCE. Continuing past it would let the
      // loop expire, stamp T3 "the step ran", shoot R6 and print SEQUENCE OK on a
      // run nobody ever released — a green walk that proves the opposite of what
      // it claims. The row above is already written, so the failure is on the
      // record as well as on the exit code.
      if (pressError !== null) throw new Error(`the run's own Continue gate could not be pressed: ${pressError}`);
      await page.waitForTimeout(6000);
      continue;
    }
    if (rows.run?.status === "failed") {
      say(`RUN FAILED: ${rows.run.error}`);
      break;
    }
    await page.waitForTimeout(10_000);
  }

  // ---- THE PROVIDER ROW, READ AGAIN AFTER THE STEP ------------------------
  //
  // T1c reads it BEFORE the step. One point read cannot say the row was present
  // THROUGHOUT, and a review said so. This is the other end of the bracket: the
  // same shipped reader, after the model call the step made. Two point reads
  // still do not prove continuity — they prove the row was there on both sides
  // of the call, which is what the sentences in README/TIMELINE now claim.
  const providerAfter = execFileSync(
    "npx",
    ["vitest", "run", "--config", "evidence/2790-s9f-host-parity/drivers/08-real-provider.config.ts"],
    { cwd: REPO_ROOT, env: { ...process.env, WALK_STEP: "PROVIDER_READ" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const providerAfterLine = providerAfter.split("\n").find((l) => l.includes("S9FREAL PROVIDER_READ")) ?? "";
  await stamp("T3a", "the sealed provider row is read AGAIN, after the step's own model call", {
    shippedReader: "readOpenAIConnection",
    readBack: providerAfterLine.trim(),
    evidence: readProviderEvidence(),
  });

  const t3 = await runRows(state.runId);
  await stamp("T3", "the step ran in the runtime and the run reached its state", {
    evidence: readProviderEvidence(),
    runStatus: t3.run?.status,
    runCompletedAt: t3.run?.completed_at,
    runError: t3.run?.error,
    representations: t3.representations,
    outbox: t3.outbox,
    gates: t3.gates,
  });
  state.reviewTaskId = t3.gates[0]?.review_task_id ?? null;

  // ---- R6: the RUN PAGE for the same run, DECIDED -------------------------
  await openRunPage(state.runId, state.packageName);
  const t4 = await runRows(state.runId);
  await stamp("T4", "the run page is photographed with the question decided", {
    runStatus: t4.run?.status,
    parkStatus: t4.park[0]?.status,
    parkResolvedAt: t4.park[0]?.resolved_at,
    selections: t4.selections,
    url: state.runPath,
  });
  await shoot("R6__recommendation-card__run_card__decided", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The same run page after the decision. What this cell OWES is the recommendation's rail entry settled as the rail's own resolved-gate history row — the check in the circle, the title unhighlighted because it is no longer the selected step — the run detail restored to the run's own panel, the settled chips in place, and nothing selectable inside the card. The record's own `runSurface` block carries the measurements every one of those four is decided on (`railStepPresent`, `railStepSettled`, `railStepSelected`, `railStepIndicatorHasCheckGlyph`, the three `[data-skill-action]` counts); PLAN-WALK.md grades it from the pixels rather than from this sentence.",
  });
  await setTheme("dark");
  await shoot("R6__recommendation-card__run_card__decided__dark", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same decided run page in the dark palette. Same owed set as the light cell, graded the same way from the record's own `runSurface` block and from the pixels.",
  });
  await setTheme("cinatra");
  say("SEQUENCE OK");
} catch (e) {
  say(`SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
  // FAIL LOUD. The artifacts below are still written (a partial run is worth
  // reading), but the process must not exit 0 on a sequence that did not finish
  // — a green exit on a broken walk is how a half-shot cell gets filed.
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
