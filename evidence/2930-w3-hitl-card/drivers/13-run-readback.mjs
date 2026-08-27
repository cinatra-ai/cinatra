// THE READBACK: every row the pictures stand on, read out of the database, plus
// the negative screens over the app server's own log. Nothing here writes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
const DB = process.env.SUPABASE_DB_URL, OUT = process.env.OUT_JSON, LOG = process.env.SERVER_LOG, PORT = process.env.APP_PORT ?? "3000";
for (const [n, v] of Object.entries({ SUPABASE_DB_URL: DB, OUT_JSON: OUT, SERVER_LOG: LOG })) if (!v) throw new Error(`needs ${n}`);
const db = new Client({ connectionString: DB }); await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const out = {
  runs: await q(`SELECT id, status, created_at, started_at, completed_at, a2a_task_id, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params, human_present, source_type FROM cinatra.agent_runs ORDER BY created_at`),
  hitlGates: await q(`SELECT run_id, review_task_id, x_renderer, field_name, materialized_at, created_at, input_schema, gate_values FROM cinatra.agent_run_hitl_gates ORDER BY created_at`),
  reviewGates: await q(`SELECT id, run_id, review_task_id, status, created_at FROM cinatra.artifact_review_gates ORDER BY created_at`),
  triggers: await q(`SELECT run_id, trigger_type, scheduled_at, timezone, released_at, created_at FROM cinatra.agent_run_triggers ORDER BY created_at`),
  usageEvents: await q(`SELECT provider, model, source, operation, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens, min(created_at) AS first_at, max(created_at) AS last_at FROM cinatra.usage_events GROUP BY 1,2,3,4 ORDER BY 5 DESC`),
  transcriptToolCalls: await q(`SELECT p->>'name' AS tool, p->>'type' AS kind FROM cinatra.assistant_turns a, LATERAL jsonb_array_elements((a.content)->'parts') p WHERE a.role='assistant' AND p->>'type' IN ('tool_call') ORDER BY a.created_at`),
  assistantTurns: await q(`SELECT role, created_at FROM cinatra.assistant_turns ORDER BY created_at`),
  threads: await q(`SELECT id, title, created_at FROM cinatra.assistant_threads ORDER BY created_at`),
};
await db.end();
// THE NEGATIVE SCREENS. A hit is proof of a problem; a zero is the absence of
// that particular line and nothing more.
const log = (() => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } })();
const count = (re) => (log.match(re) ?? []).length;
out.negativeScreens = {
  scriptedRuntimeLines: count(/CINATRA_TEST_LLM_PROVIDER|scripted provider|scripted-llm/gi),
  noProviderRefusals: count(/no (model )?provider (is )?configured/gi),
  mcpToolListFailures: count(/MCP tool enumeration failed/gi),
  // THE SHIPPED SPELLINGS, corrected. The server writes "is unreachable"
  // (src/.../assistant-runtime, cinatra#1699) while the message it STORES on the
  // refused turn reads "is not reachable" — the earlier regex matched the stored
  // wording and therefore counted ZERO on a session that really did refuse four
  // turns. A negative screen that cannot see its own subject is worse than none,
  // so both spellings are counted and the positive callback line is counted too.
  publicMcpRefusals: count(/public MCP URL .* is (?:not reachable|unreachable)/gi),
  publicMcpCallbacks: count(/POST \/api\/mcp 200/g),
  bridgeRunSelects: count(/\[llm-bridge-run-select\]/g),
  sessionLogBytes: log.length,
};
// The flag, read one hop above the listening process from the process table.
out.serverScriptedProviderEnv = (() => {
  try {
    const pid = execFileSync("bash", ["-lc", `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | head -1`]).toString().trim();
    if (!pid) return { pid: null, readFrom: "process-table", value: null, note: "no listening process found" };
    const envs = execFileSync("bash", ["-lc", `ps -E -o command= -p ${pid} 2>/dev/null | tr ' ' '\\n' | grep -c '=' || true`]).toString().trim();
    const hit = execFileSync("bash", ["-lc", `ps -E -o command= -p ${pid} 2>/dev/null | tr ' ' '\\n' | grep -c '^CINATRA_TEST_LLM_PROVIDER=' || true`]).toString().trim();
    return { pid, readFrom: "process-table", tokensSeen: Number(envs), scriptedProviderTokens: Number(hit), value: Number(hit) > 0 ? "PRESENT" : null };
  } catch (e) { return { readFrom: "process-table", error: String(e).slice(0, 200) }; }
})();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ runs: out.runs.length, hitlGates: out.hitlGates.length, reviewGates: out.reviewGates.length, usage: out.usageEvents, negativeScreens: out.negativeScreens, env: out.serverScriptedProviderEnv }, null, 2));
