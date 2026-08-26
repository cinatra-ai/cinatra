// THE ROUND 8 READBACK (cinatra#2970, PR #2975).
//
// Reads the lane's own rows back out of the database and writes them unedited,
// beside the runtime screens each grep produced. Nothing here writes a row.
//
//   env: SUPABASE_DB_URL (the lane database), SERVER_LOG (the lane server's own
//   log), OUT_JSON, OUT_TXT
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "pg";

const DB = process.env.SUPABASE_DB_URL;
const LOG = process.env.SERVER_LOG;
const OUT = process.env.OUT_JSON;
const TXT = process.env.OUT_TXT;
for (const [n, v] of Object.entries({ SUPABASE_DB_URL: DB, SERVER_LOG: LOG, OUT_JSON: OUT, OUT_TXT: TXT }))
  if (!v) throw new Error(`the readback driver needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const runs = await q(`
  SELECT r.id, t.package_name, t.name AS template_name, r.status, r.created_at, r.started_at,
         r.completed_at, r.human_present, r.source_type,
         (SELECT count(*)::int FROM cinatra.agent_run_triggers x WHERE x.run_id = r.id) AS trigger_rows,
         (SELECT json_agg(json_build_object('type', x.trigger_type, 'scheduled_at', x.scheduled_at,
                 'timezone', x.timezone, 'enabled', x.enabled, 'released_at', x.released_at))
            FROM cinatra.agent_run_triggers x WHERE x.run_id = r.id) AS triggers,
         (SELECT count(*)::int FROM cinatra.artifact_review_gates g WHERE g.run_id = r.id) AS review_gates,
         (SELECT json_agg(json_build_object('checkpoint', p.checkpoint, 'status', p.status,
                 'created_at', p.created_at, 'resolved_at', p.resolved_at))
            FROM cinatra.lifecycle_continuation_park p WHERE p.run_id = r.id) AS parks,
         (SELECT count(*)::int FROM cinatra.artifact_produced_outbox o WHERE o.producer_run_id = r.id) AS produced_outbox_rows
    FROM cinatra.agent_runs r JOIN cinatra.agent_templates t ON t.id = r.template_id
   ORDER BY r.created_at`);

const outbox = await q(`
  SELECT producer_run_id, event_id, status, created_at, processed_at
    FROM cinatra.artifact_produced_outbox ORDER BY created_at`);
const gates = await q(`
  SELECT run_id, review_task_id, status, created_at FROM cinatra.artifact_review_gates ORDER BY created_at`);
const usage = await q(`
  SELECT provider, model, count(*)::int AS calls, sum(coalesce(input_tokens,0))::int AS input_tokens,
         sum(coalesce(output_tokens,0))::int AS output_tokens
    FROM cinatra.usage_events GROUP BY provider, model ORDER BY calls DESC`);
const installs = await q(`
  SELECT package_name, kind, owner_level, status, version FROM cinatra.installed_extension
   WHERE kind = 'agent' ORDER BY package_name`);
const matches = await q(`SELECT agent_id, skill_id, matched FROM cinatra.skill_matches ORDER BY agent_id`);
await db.end();

// ── the runtime screens, each with the grep that produced it ────────────────
const log = readFileSync(LOG, "utf8");
const count = (re) => (log.match(re) ?? []).length;
const screens = {
  scriptedRuntimeLines: {
    grep: "/CINATRA_UAT_OK|scripted (runtime|provider)|deterministic chat reply/i",
    count: count(/CINATRA_UAT_OK|scripted (runtime|provider)|deterministic chat reply/gi),
  },
  noProviderRefusals: {
    grep: "/no provider configured|no model provider/i",
    count: count(/no provider configured|no model provider/gi),
  },
  preRouterShortCircuits: {
    grep: "/explicit-dispatch pre-router HARD short-circuit/",
    count: count(/explicit-dispatch pre-router HARD short-circuit/g),
  },
  publicMcpCallbacks: { grep: "/POST \\/api\\/mcp 200/", count: count(/POST \/api\/mcp 200/g) },
  publicMcpUnreachableRefusals: {
    grep: "/public MCP URL .* is unreachable/",
    count: count(/public MCP URL .* is unreachable/g),
  },
  llmBridgeRunSelects: { grep: "/\\[llm-bridge-run-select\\]/", count: count(/\[llm-bridge-run-select\]/g) },
};

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(resolve(OUT), `${JSON.stringify({
  round: 8,
  readAt: new Date().toISOString(),
  runtime: "dev-runtime",
  // This host prints no environment at all for the listening process, so a
  // process-table read establishes nothing. Recorded rather than left to imply.
  serverEnvAvailable: false,
  runs, outbox, gates, usage, installedAgents: installs, skillMatches: matches, screens,
}, null, 2)}\n`);

// The lines themselves, with the public origin redacted (a committed hostname is
// a leak and a lane the next operator cannot reproduce).
// EVERY line written here goes through ONE redaction, and it is wider than the
// round 7 rule: that rule only rewrote https origins, and the dev server also
// prints a bare host address on its own startup line. Origin, host address and
// funnel name are all replaced before a line can reach a committed file.
const redact = (l) => l
  .replace(/https?:\/\/[^\s/]*\.ts\.net/gi, "<the lane's public origin>")
  .replace(/https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, "<the lane's host address>")
  .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (m) => (m === "127.0.0.1" ? m : "<the lane's host address>"))
  .replace(/[A-Za-z0-9-]+\.ts\.net/gi, "<the lane's public origin>");
const pick = (re, cap = 12) => log.split("\n").filter((l) => re.test(l)).slice(0, cap)
  .map(redact)
  .join("\n");
writeFileSync(resolve(TXT), [
  "# Round 8 runtime evidence (cinatra#2970, PR #2975).",
  "# Each block names the grep that produced it. The instance's public origin is",
  "# redacted everywhere it occurs. A zero-result grep is not a capture of the",
  "# process environment: this host prints no environment for the listening",
  "# process, which the readback records as serverEnvAvailable: false.",
  "",
  "## grep -E 'public MCP URL .* is unreachable'  (the pre-turn reachability refusals, left in)",
  pick(/public MCP URL .* is unreachable/),
  "",
  "## grep -E 'explicit-dispatch pre-router HARD short-circuit'  (the app's own dispatch of a named agent)",
  pick(/explicit-dispatch pre-router HARD short-circuit/),
  "",
  "## grep -E '\\[llm-bridge-run-select\\]'  (the agent runtime resolving this instance's sealed connection by run token)",
  pick(/\[llm-bridge-run-select\]/, 4),
  "",
  "## grep -E 'POST /api/mcp 200' | tail  (the provider's own servers calling back over the public ingress)",
  log.split("\n").filter((l) => /POST \/api\/mcp 200/.test(l)).slice(-4).map(redact).join("\n"),
  "",
  "## grep -icE 'CINATRA_UAT_OK|scripted (runtime|provider)|deterministic chat reply'",
  String(screens.scriptedRuntimeLines.count),
  "",
].join("\n"));
console.log(`wrote ${OUT} and ${TXT}`);
