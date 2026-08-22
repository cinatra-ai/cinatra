// ---------------------------------------------------------------------------
// cinatra#2902 run-panel capture, step 2 — put TWO REAL agent runs in the lane
// database: one the capture's reader is entitled to, and one they are not.
//
// WHY TWO. The round has to show both halves of the same rule. The BOUND run is
// the reader's own, in the org their widget credential is bound to, and it must
// draw. The UNBOUND run is a real row in a DIFFERENT organization, and it must
// be refused by the binding with the branch's one uniform answer — with the
// SAME credential, on the SAME screen, in the SAME conversation. A round that
// showed only the first would prove the panel loads and prove nothing about who
// it loads for.
//
// WHAT IS STOOD IN FOR, SAID EXACTLY: the DISPATCH. These rows are inserted
// rather than produced by a live agent execution, because a run needs a model
// provider and no provider credential exists on a capture host. Everything the
// round then measures is the shipped path — the guard's admission, the token
// consume, the per-run authorization ladder, the serializer, and the panel's
// own render of what came back. The rows carry no invented capability: they are
// ordinary `completed` runs with ordinary assistant messages.
//
// WHY `completed`, deliberately. A terminal run starts no poll and opens no
// stream, so what the pictures show is the SEED and the render and nothing else
// — which is exactly the scope this slice claims. The panel's live transports
// are separately session-only and are named as follow-up, not photographed here
// as if they worked.
//
// Usage: node --env-file=.env.local seed-agent-runs.mjs
//   with SEED_ORG_ID / SEED_USER_ID / SEED_OUT in the environment.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Client } from "pg";

const DB = process.env.SUPABASE_DB_URL;
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');
const ORG = process.env.SEED_ORG_ID;
const USER = process.env.SEED_USER_ID;
const OUT = process.env.SEED_OUT;
for (const [k, v] of Object.entries({ SUPABASE_DB_URL: DB, SEED_ORG_ID: ORG, SEED_USER_ID: USER, SEED_OUT: OUT })) {
  if (!v) throw new Error(`missing ${k}`);
}

const db = new Client({ connectionString: DB });
await db.connect();

const [tpl] = (
  await db.query(`select id, package_name from "${SCHEMA}".agent_templates order by package_name limit 1`)
).rows;
if (!tpl) throw new Error("the lane has no agent templates — run pnpm setup:dev first");

async function insertRun({ id, orgId, runBy, title }) {
  await db.query(
    `insert into "${SCHEMA}".agent_runs
       (id, template_id, status, input_params, source_type, org_id, run_by, human_present, ag_ui_enabled, title, started_at, completed_at)
     values ($1,$2,'completed','{}','agent_builder',$3,$4,true,false,$5, now() - interval '4 minutes', now() - interval '1 minute')
     on conflict (id) do nothing`,
    [id, tpl.id, orgId, runBy, title],
  );
  const rows = [
    { role: "user", type: "text", body: "Draft the launch note for the connector rollout." },
    { role: "assistant", type: "text", body: "The launch note is drafted and saved to the workspace." },
  ];
  let seq = 0;
  for (const r of rows) {
    await db.query(
      `insert into "${SCHEMA}".agent_run_messages
         (id, run_id, sequence, role, message_type, content, content_json)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing`,
      [randomUUID(), id, seq++, r.role, r.type, r.body, JSON.stringify({ text: r.body })],
    );
  }
}

// 1. THE BOUND RUN — this reader's own, in the org their `cwu_` is bound to.
const boundRunId = randomUUID();
await insertRun({ id: boundRunId, orgId: ORG, runBy: USER, title: "Connector rollout launch note" });

// 2. THE UNBOUND RUN — a real row in ANOTHER organization, owned by somebody
//    else. Nothing about the request that asks for it differs; only the run's
//    tenancy does, which is what makes it a control rather than a second case.
const otherOrgId = `org-2902-control-${randomUUID().slice(0, 8)}`;
const otherUserId = `user-2902-control-${randomUUID().slice(0, 8)}`;
const unboundRunId = randomUUID();
await insertRun({ id: unboundRunId, orgId: otherOrgId, runBy: otherUserId, title: "Another tenant's run" });

const back = await db.query(
  `select id, org_id, run_by, status, ag_ui_enabled,
          (select count(*) from "${SCHEMA}".agent_run_messages m where m.run_id = r.id) as messages
     from "${SCHEMA}".agent_runs r where r.id = any($1)`,
  [[boundRunId, unboundRunId]],
);
await db.end();

const out = {
  templateId: tpl.id,
  templatePackage: tpl.package_name,
  boundRunId,
  unboundRunId,
  boundOrgId: ORG,
  unboundOrgId: otherOrgId,
  rows: back.rows,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("SEEDED RUNS OK");
