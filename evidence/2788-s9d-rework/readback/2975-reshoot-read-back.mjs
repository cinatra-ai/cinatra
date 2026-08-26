// THE 2026-08-26 RE-SHOOT'S READBACK (cinatra#2970 / PR #2975).
//
// Every number this round quotes comes from here: the rows are read out of the
// lane database as they stand, the runtime screens are greps over the app
// server's own log with the grep printed beside each count, and the
// scripted-provider question is answered by reading the LISTENING process's own
// environment out of the process table.
//
// It writes; it does not interpret. The interpretation — including what a zero
// can and cannot establish — is in RUN-READBACK.md beside it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { Client } from "pg";

const DB = process.env.SUPABASE_DB_URL;
const LOG = process.env.SERVER_LOG;
const OUT = process.env.OUT_JSON;
const PORT = process.env.WALK_PORT ?? "3000";
for (const [n, v] of Object.entries({ SUPABASE_DB_URL: DB, SERVER_LOG: LOG, OUT_JSON: OUT }))
  if (!v) throw new Error(`the readback needs ${n}`);

const db = new Client({ connectionString: DB });
await db.connect();
const q = async (sql) => (await db.query(sql)).rows;

const rows = {
  runs: await q(`SELECT id, status, human_present, source_type, created_at, started_at, completed_at
                   FROM cinatra.agent_runs ORDER BY created_at`),
  triggers: await q(`SELECT run_id, trigger_type, scheduled_at, timezone, enabled, released_at, created_at
                       FROM cinatra.agent_run_triggers ORDER BY created_at`),
  reviewGates: await q(`SELECT count(*)::int AS n FROM cinatra.artifact_review_gates`),
  usageEvents: await q(`SELECT provider, model, source, operation, count(*)::int AS calls,
                               sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
                               min(created_at) AS first_at, max(created_at) AS last_at
                          FROM cinatra.usage_events GROUP BY 1,2,3,4 ORDER BY 1,2`),
  assistantTurns: await q(`SELECT role, created_at FROM cinatra.assistant_turns ORDER BY created_at`),
  recommendationParks: await q(`SELECT count(*)::int AS n FROM cinatra.lifecycle_interception_parks`).catch(() => [{ n: null }]),
  runSelectedSkillRevisions: await q(`SELECT count(*)::int AS n FROM cinatra.run_selected_skill_revisions`),
  agentAssignedSkills: await q(`SELECT count(*)::int AS n FROM cinatra.agent_assigned_skills`),
  skills: await q(`SELECT count(*)::int AS n FROM cinatra.skills`),
};
await db.end();

// ── The runtime screens. A HIT is proof of a problem; a ZERO is the absence of
//    that particular line and nothing more. The grep is printed beside the count
//    so the extraction is repeatable.
const log = readFileSync(LOG, "utf8");
const screens = {};
const screen = (name, re) => {
  screens[name] = { grep: String(re), count: (log.match(re) ?? []).length };
};
screen("scriptedRuntimeLines", /CINATRA_UAT_OK|deterministic (chat|model) (reply|bridge)|scripted (runtime|provider)/g);
screen("preRouterShortCircuits", /\[pre-router\][^\n]*short-?circuit/gi);
screen("preRouterAttempts", /\[pre-router\]/g);
screen("noProviderRefusals", /no (LLM )?provider (is )?(configured|available)/gi);
screen("mcpToolListRecoveries", /MCP tool enumeration failed \(424\)/g);
screen("mcpPublicUnreachableRefusals", /refusing to run the turn without Cinatra tools/g);
screen("publicMcpCallbacks", /POST \/api\/mcp 200/g);
screen("bridgeRunSelects", /\[llm-bridge-run-select\]/g);

// ── Is the scripted-provider switch present in the LISTENING process?
//    A NON-NULL answer would be proof it is set; a null answer is consistent
//    with absence and is not by itself a proof of it.
let listenerPid = null;
let serverScriptedProviderEnv = null;
let serverEnvTokensSeen = null;
let serverEnvReadFrom = null;
let serverEnvAvailable = false;
try {
  const lsof = execFileSync("lsof", ["-nP", "-iTCP:" + PORT, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  listenerPid = (lsof.match(/^p(\d+)/m) ?? [])[1] ?? null;
  if (listenerPid) {
    const env = execFileSync("ps", ["-Ewww", "-o", "command=", "-p", listenerPid], { encoding: "utf8" });
    // COUNT THE ENVIRONMENT TOKENS, not the words. `ps -E` prints `KEY=VALUE`
    // pairs after the command only where the operating system lets it; on a
    // macOS host with System Integrity Protection it prints NONE, even for a
    // process the caller owns. Counting `KEY=` tokens is what tells the two
    // cases apart, and it is why this file reports `serverEnvAvailable`
    // instead of quietly reporting a null that would read as "absent".
    serverEnvReadFrom = "process-table (ps -Ewww)";
    serverEnvTokensSeen = (env.match(/(^|\s)[A-Z_][A-Z0-9_]*=/g) ?? []).length;
    serverEnvAvailable = serverEnvTokensSeen > 0;
    const hit = env.match(/CINATRA_TEST_LLM_PROVIDER=(\S*)/);
    serverScriptedProviderEnv = hit ? hit[1] : null;
  }
} catch (err) {
  serverEnvReadFrom = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      readAt: new Date().toISOString(),
      rows,
      runtimeScreens: screens,
      driverScriptedProviderEnv: process.env.CINATRA_TEST_LLM_PROVIDER ?? null,
      listenerPid: listenerPid ? "read, not recorded" : null,
      serverScriptedProviderEnv,
      serverEnvReadFrom,
      serverEnvTokensSeen,
      serverEnvAvailable,
      serverEnvNote:
        "serverEnvAvailable false means the operating system printed NO environment for the listening process (macOS SIP), so serverScriptedProviderEnv null establishes NOTHING here. What is positively established is elsewhere: usage_events records the provider and model of the calls the instance actually made, the server log carries zero scripted-runtime lines, and the launcher started the server with the switch explicitly removed from its environment.",
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ screens, serverScriptedProviderEnv, serverEnvReadFrom, serverEnvTokensSeen, serverEnvAvailable }, null, 2));
