// ---------------------------------------------------------------------------
// THE LANE'S SHARED PIECES — sign-in, the clock, the database reads, and the
// provider-evidence reader every shutter in this directory is gated on.
//
// NOTHING HERE WRITES TO THE DATABASE. Every state these pictures show is
// produced by the product's own surfaces: a schedule is STATED in the shipped
// composer and CONFIRMED on the card, a change is saved with the card's own
// Save changes, and a recurring schedule is stopped with its own Cancel
// schedule. The only SQL in this lane is `select`.
//
// Adapted from evidence/2790-s9f-host-parity/drivers/12-real-chain-sequence.mjs,
// which is the shape a real-chain capture lane reads its evidence with.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

export const APP = need("APP");
export const SERVER_LOG = need("SERVER_LOG");
export const DB_URL = need("SUPABASE_DB_URL");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`this lane needs ${name} in the environment`);
  return v;
}

/** The scripted provider is banned from this lane outright. */
if (process.env.CINATRA_TEST_LLM_PROVIDER) {
  throw new Error("CINATRA_TEST_LLM_PROVIDER is set in this process — refusing to run");
}

export const say = (...a) => console.log(...a);
export const settle = (page, ms) => page.waitForTimeout(ms);

// ---------------------------------------------------------------------------
// THE DATABASE — read-only
// ---------------------------------------------------------------------------
export async function db() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const q = async (text, values = []) => (await client.query(text, values)).rows;
  return { client, q, end: () => client.end() };
}

/** The trigger row as the database holds it, with every stamp this slice added. */
export const TRIGGER_SQL = `select run_id, trigger_type, scheduled_at, cron_expression, timezone,
    enabled, released_at, last_fired_at, stopped_at,
    (job_scheduler_id is not null) as has_job_scheduler, created_at, updated_at
  from cinatra.agent_run_triggers where run_id = $1`;

/** The run row, and the children a recurring tick cloned from it. */
export const RUN_SQL = `select id, status, template_id, created_at, completed_at
  from cinatra.agent_runs where id = $1`;
/**
 * THE RUNS THAT ARE CANDIDATES FOR A TICK'S CLONE — a SQL heuristic, and named
 * as one.
 *
 * A clone is armed by the release job as an IMMEDIATE trigger
 * (`trigger-release-job.ts`: "each cron tick creates a fresh pending run + arms
 * it as immediate"), so the join below separates a tick's child from the lane's
 * own one-off, whose trigger is `scheduled`. IT DOES NOT PROVE PARENTAGE:
 * `agent_runs.parent_run_id` is NOT set by the recurring clone path, so no
 * column in the database links a child to the schedule that produced it, and any
 * other immediate run of the same template inside the window would answer this
 * query too.
 *
 * WHAT DOES NAME THE PARENT is the release job's OWN log line, read by
 * `readClonesFromServerLog` below:
 *
 *     [trigger-release] recurring tick — created new run <child> from <parent>
 *
 * That line is written by the shipped job at the moment it clones, names both
 * ids, and is what the records lean on. The SQL result is kept beside it as the
 * database-side corroboration, and the two are recorded under different names so
 * a reader can see which is which.
 */
export const CHILD_CANDIDATES_SQL = `select r.id, r.status, r.created_at
  from cinatra.agent_runs r
  join cinatra.agent_run_triggers t on t.run_id = r.id
  where r.template_id = $1 and r.created_at > $2 and r.id <> $3
    and t.trigger_type = 'immediate'
  order by r.created_at`;

/**
 * The runs the release job itself says it cloned FROM a given run, read out of
 * the app server's own log. This is the parentage evidence; the SQL above is the
 * corroboration.
 */
export function readClonesFromServerLog(parentRunId) {
  let text = "";
  try {
    text = readFileSync(SERVER_LOG, "utf8");
  } catch {
    return { unreadable: true, clones: [] };
  }
  const re = /\[trigger-release\] recurring tick — created new run ([0-9a-f-]{36}) from ([0-9a-f-]{36})/g;
  const clones = [];
  for (const m of text.matchAll(re)) if (m[2] === parentRunId) clones.push(m[1]);
  return { unreadable: false, clones };
}

/**
 * The shipped usage ledger's rows SINCE a given instant — the provider evidence
 * that is correlated to this round rather than to the whole database.
 *
 * WHAT IT CORRELATES BY, said plainly: TIME. `usage_events` records the provider
 * and the model of every call but carries no thread or turn id, so a row inside
 * the window is a call this lane made during the window, not provably the call
 * behind one particular turn. What the window does establish is that no call in
 * it was served by the scripted runtime, which writes its own model id.
 */
export const USAGE_WINDOW_SQL = `select provider, model, count(*)::int as calls,
    min(occurred_at) as first_at, max(occurred_at) as last_at
  from cinatra.usage_events where occurred_at >= $1
  group by provider, model order by calls desc`;

// ---------------------------------------------------------------------------
// THE PROVIDER-EVIDENCE READER
//
// Every counter is a COUNT OF LINES IN THE APP SERVER'S OWN LOG at the instant
// it is read. The five NEGATIVE SCREENS must be zero at every shutter, and a
// non-zero one ABORTS rather than shoots. A screen is worth what a screen is
// worth: a hit proves a stood-in leg, a zero is the absence of that one line.
// ---------------------------------------------------------------------------
const EVIDENCE_PATTERNS = {
  preRouterShortCircuits: /explicit-dispatch pre-router HARD short-circuit/g,
  preRouterAttempts: /explicit-dispatch pre-router (?:HARD attempt failed|TERMINAL failure)/g,
  scriptedRuntimeLines: /scripted (?:runtime|provider|stream)|CINATRA_TEST_LLM_PROVIDER/g,
  noProviderRefusals: /NO_LLM_PROVIDER/g,
  mcpDependencyFailures: /424 Failed Dependency|Failed Dependency|could not reach this instance's public MCP/g,
  publicMcpCallbacks: /^\s*POST \/api\/mcp /gm,
  bridgeRunSelects: /\[llm-bridge-run-select\]/g,
  triggerReleaseLines: /\[trigger-release\]/g,
};
export const EVIDENCE_MUST_BE_ZERO = [
  "preRouterShortCircuits",
  "preRouterAttempts",
  "scriptedRuntimeLines",
  "noProviderRefusals",
  "mcpDependencyFailures",
];

export function readProviderEvidence() {
  let text = "";
  try {
    text = readFileSync(SERVER_LOG, "utf8");
  } catch (e) {
    return { unreadable: e instanceof Error ? e.message : String(e) };
  }
  const out = { serverLog: "<the app server's own log>", at: new Date().toISOString() };
  for (const [name, re] of Object.entries(EVIDENCE_PATTERNS)) out[name] = (text.match(re) ?? []).length;
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
 * Read `CINATRA_TEST_LLM_PROVIDER` out of the app server's PROCESS CHAIN.
 *
 * THE ASYMMETRY, stated because it is the whole worth of the field: a NON-NULL
 * answer proves the flag is present and aborts; a NULL answer read one hop above
 * a listener that rewrote its argv is CONSISTENT with absence and is not a proof
 * of it. The process is found from the app origin's own listening socket, never
 * from a pid handed in. Only that one variable is extracted.
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
        readFrom: "process-table",
        readOfPid: pid,
        hopsFromListener: hop,
        envTokensSeen: tokens.length,
      };
    }
    const parent = run("ps", ["-o", "ppid=", "-p", pid]).trim();
    if (!parent || parent === "0" || parent === pid) break;
    pid = parent;
    chain.push(pid);
  }
  return { value: null, readFrom: `unavailable: no readable environment in the process chain` };
}

/** Read the evidence and REFUSE to continue unless the chain still looks real. */
export function assertRealChain(where) {
  const e = readProviderEvidence();
  if (e.unreadable) throw new Error(`${where}: the app server's log could not be read (${e.unreadable})`);
  for (const k of EVIDENCE_MUST_BE_ZERO) {
    if (e[k] !== 0) throw new Error(`${where}: ${k} is ${e[k]} — a stood-in leg served this chain; refusing to shoot`);
  }
  if (e.serverScriptedProviderEnv !== null) {
    throw new Error(`${where}: the scripted provider switch is present in the app server's process chain`);
  }
  if (!String(e.serverEnvReadFrom).startsWith("process-table")) {
    throw new Error(`${where}: the app server's environment could not be read (${e.serverEnvReadFrom})`);
  }
  return e;
}

// ---------------------------------------------------------------------------
// SIGN IN through the app's own hosted form.
// ---------------------------------------------------------------------------
export async function signIn(page) {
  const email = need("LANE_ACCOUNT");
  const password = need("LANE_SECRET");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector('input[name="email"]', { timeout: 300_000 });
    await page.waitForTimeout(4000);
    const em = page.locator('input[name="email"]').first();
    const pw = page.locator('input[name="password"]').first();
    await em.click(); await em.fill(""); await em.pressSequentially(email, { delay: 12 });
    await pw.click(); await pw.fill(""); await pw.pressSequentially(password, { delay: 8 });
    if ((await em.inputValue()) !== email) continue;
    await page.locator('button[type="submit"]').first().click();
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(1500);
      if (!new URL(page.url()).pathname.startsWith("/sign-in")) {
        const ok = await page.evaluate(async () => {
          const r = await fetch("/api/auth/get-session", { credentials: "include" });
          const j = r.ok ? await r.json().catch(() => null) : null;
          return j?.user?.id ? "yes" : null;
        });
        if (ok) return new URL(page.url()).pathname;
        break;
      }
    }
  }
  throw new Error("sign-in did not establish a session");
}

// ---------------------------------------------------------------------------
// THE SHIPPED SELECTORS this lane drives and observes.
// ---------------------------------------------------------------------------
export const SEL = {
  composer: 'div[contenteditable="true"][role="textbox"]',
  card: '[data-lifecycle-card="trigger_schedule_proposal"]',
  cardRoot: '[data-conformance-id="schedule-proposal-card"]',
  floor: '[data-conformance-id="schedule-proposal-floor"]',
  confirm: '[data-action="confirm-schedule-proposal"]',
  save: '[data-action="save-schedule-changes"]',
  cancel: '[data-action="cancel-trigger-schedule"]',
  confirmDestructive: '[data-action="confirm-destructive"]',
  runNow: '[data-action="release-trigger-now"]',
  optionRows: '[data-conformance-id="schedule-option-rows"]',
  runAt: '[data-field="schedule-run-at"]',
  timezone: '[data-field="schedule-timezone"]',
  recurringTz: '[data-field="recurring-timezone"]',
  recurringHour: '[data-field="recurring-hour"]',
  recurringMinute: '[data-field="recurring-minute"]',
  recurringFreq: '[data-field="recurring-frequency"]',
  recurringInterval: '[data-field="recurring-interval"]',
  railStep: '[data-conformance-id="schedule-rail-step"]',
  railColumn: '[data-conformance-id="run-step-rail-column"]',
  detailColumn: '[data-conformance-id="run-detail-column"]',
  stepDetail: '[data-conformance-id="schedule-step-detail"]',
  promptWindow: '[data-conformance-id="schedule-prompt-window"]',
  host: "[data-lifecycle-card-host]",
  conversationList: "[data-conversation-list], [data-conformance-id='conversation-list']",
};
