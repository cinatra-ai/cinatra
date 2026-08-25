// The lane's rows, read out of the database at the end of the round, and the
// app server's own provider-evidence counters at the same instant. Read-only.
import { writeFileSync } from "node:fs";
import { db, readProviderEvidence, readClonesFromServerLog, USAGE_WINDOW_SQL, EVIDENCE_MUST_BE_ZERO } from "./00-lane.mjs";
const { q, end } = await db();
const runs = await q(`select id, status, template_id, created_at, completed_at,
    case when coalesce(error,'') = '' then null else left(error, 200) end as error
  from cinatra.agent_runs order by created_at`);
const triggers = await q(`select run_id, trigger_type, scheduled_at, cron_expression, timezone, enabled,
    released_at, last_fired_at, stopped_at, (job_scheduler_id is not null) as has_job_scheduler,
    created_at, updated_at
  from cinatra.agent_run_triggers order by created_at`);
// THE LEDGER FOR THIS ROUND, not for the whole database. `ROUND_STARTED_AT` is
// the instant the walk began; a row inside the window is a call this lane made
// during the round. The ledger carries no turn id, so the window correlates by
// TIME and says so — what it establishes is that no call in it was served by the
// scripted runtime, which writes its own model id.
const usageThisRound = await q(USAGE_WINDOW_SQL, [process.env.ROUND_STARTED_AT ?? new Date(0)])
  .catch(() => "usage_events not readable on this lane");
const usageAllTime = await q(`select provider, model, count(*)::int as calls
  from cinatra.usage_events group by provider, model order by calls desc`).catch(() => "usage_events not readable on this lane");
const evidence = readProviderEvidence();
const screensZero = Object.fromEntries(EVIDENCE_MUST_BE_ZERO.map((k) => [k, evidence[k]]));
const clonesNamedByTheReleaseJob = Object.fromEntries(
  triggers.filter((t) => t.trigger_type === "recurring").map((t) => [t.run_id, readClonesFromServerLog(t.run_id).clones]),
);
const out = {
  readAt: new Date().toISOString(), roundStartedAt: process.env.ROUND_STARTED_AT ?? null,
  runs, triggers, usageThisRound, usageAllTime, clonesNamedByTheReleaseJob, evidence, screensZero,
};
writeFileSync(process.env.OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ runs: runs.length, triggers: triggers.length, screensZero, usageThisRound, clonesNamedByTheReleaseJob }, null, 1));
await end();
