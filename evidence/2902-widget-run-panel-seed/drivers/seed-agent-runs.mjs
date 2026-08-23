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
//   with SEED_ORG_ID / SEED_USER_ID / SEED_OUT / SEED_APP_BASE /
//   SEED_READER_EMAIL in the environment.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Client } from "pg";

const DB = process.env.SUPABASE_DB_URL;
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');
const ORG = process.env.SEED_ORG_ID;
const USER = process.env.SEED_USER_ID;
const OUT = process.env.SEED_OUT;
const BASE = process.env.SEED_APP_BASE;
const READER_EMAIL = process.env.SEED_READER_EMAIL;
for (const [k, v] of Object.entries({
  SUPABASE_DB_URL: DB,
  SEED_ORG_ID: ORG,
  SEED_USER_ID: USER,
  SEED_OUT: OUT,
  SEED_APP_BASE: BASE,
  SEED_READER_EMAIL: READER_EMAIL,
})) {
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
  // `content_json` IS the shipped message BODY, not a loose payload: the store
  // writes `JSON.stringify(body)` (packages/agents/src/store.ts,
  // `appendAgentRunMessage`) and every reader parses it straight back into an
  // `AgentRunMessageBody` — `{ messageType, role, text }` for a text row. A row
  // seeded as `{ text }` alone carries no `messageType`, and the panel's own
  // `buildLabelAndContent` switch then returns `undefined`, which the run panel
  // destructures and dies on ("Cannot destructure property 'label'"). That is a
  // defect in the SEED, not in the panel: the shipped writer cannot produce such
  // a row. Measured on the capture host on 2026-08-22, and fixed here.
  let seq = 0;
  for (const r of rows) {
    await db.query(
      `insert into "${SCHEMA}".agent_run_messages
         (id, run_id, sequence, role, message_type, content, content_json)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing`,
      [
        randomUUID(),
        id,
        seq++,
        r.role,
        r.type,
        r.body,
        JSON.stringify({ messageType: r.type, role: r.role, text: r.body }),
      ],
    );
  }
}

// 1. THE BOUND RUN — this reader's own, in the org their `cwu_` is bound to.
const boundRunId = randomUUID();
await insertRun({ id: boundRunId, orgId: ORG, runBy: USER, title: "Connector rollout launch note" });

// 2. THE UNBOUND RUN — a real row in a REAL other organization, owned by a REAL
//    other person. Nothing about the request that asks for it differs; only the
//    run's tenancy does, which is what makes it a control rather than a second
//    case.
//
//    THE SECOND TENANT IS REGISTERED THROUGH THE SHIPPED ROUTES, and that is
//    load-bearing TWICE.
//
//    (a) The refusal has to come from the shipped ladder meeting a real tenancy,
//        not from an id nobody can resolve.
//    (b) It is ALSO what keeps the capture's reader an ordinary member. The
//        instance promotes the first human account to PLATFORM ADMIN on sign-in
//        while exactly one human exists (`src/lib/auth.ts`, the initial-admin
//        bootstrap). A platform admin is a rung of the very ladder the control
//        is supposed to fail on — `readAgentRunById` reads owner / co-owner /
//        same-org / platform-admin — so with only one human on the lane, the
//        reader was silently re-promoted after every demotion and answered 200
//        for another tenant's run on BOTH branches. Measured that way on
//        2026-08-22. With a second human registered here the bootstrap is no
//        longer eligible, the demotion sticks, and the control means what it
//        says.
const jar = new Map();
const captureCookies = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function appPost(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json", Cookie: cookieHeader() },
    body: JSON.stringify(body),
  });
  captureCookies(res);
  return res;
}

const otherEmail = `other-tenant-2902-${randomUUID().slice(0, 8)}@example.com`;
const otherPassword = `other-tenant-2902-${randomUUID().slice(0, 12)}`;
console.log(`other tenant sign-up: ${(await appPost("/api/auth/sign-up/email", { email: otherEmail, password: otherPassword, name: "Another Tenant" })).status}`);
console.log(`other tenant sign-in: ${(await appPost("/api/auth/sign-in/email", { email: otherEmail, password: otherPassword })).status}`);
// Organization creation is admin-gated on this instance, for the second account
// exactly as for the first: promote, create, demote. The second tenant ends as
// an ordinary member, like the first.
await db.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [otherEmail]);
const orgRes = await appPost("/api/auth/organization/create", {
  name: "2902 Other Tenant Org",
  slug: `other-tenant-2902-${randomUUID().slice(0, 8)}`,
});
const orgBody = await orgRes.text();
await db.query(`UPDATE public."user" SET role='user' WHERE email=$1`, [otherEmail]);
let otherOrgId = null;
try { otherOrgId = JSON.parse(orgBody)?.id ?? null; } catch {}
console.log(`other tenant org create: ${orgRes.status} ${otherOrgId ?? orgBody.slice(0, 160)}`);
if (!otherOrgId) throw new Error("the second tenant's organization was not created — the control cannot be built");
const otherUserId = (await db.query(`SELECT id FROM public."user" WHERE email=$1`, [otherEmail])).rows[0]?.id;
if (!otherUserId) throw new Error("the second tenant's user row is missing");
if (otherOrgId === ORG || otherUserId === USER) throw new Error("the control landed in the reader's own tenancy");
const unboundRunId = randomUUID();
await insertRun({ id: unboundRunId, orgId: otherOrgId, runBy: otherUserId, title: "Another tenant's run" });

// 3. THE READER IS AN ORDINARY MEMBER AT CAPTURE TIME, asserted rather than
//    assumed — see (b) above for what put this line here.
await db.query(`UPDATE public."user" SET role='user' WHERE email=$1`, [READER_EMAIL]);
const readerRole = (await db.query(`SELECT role FROM public."user" WHERE email=$1`, [READER_EMAIL])).rows[0]?.role;
console.log(`capture reader role: ${readerRole}`);
if (String(readerRole ?? "").split(",").map((r) => r.trim()).includes("admin")) {
  throw new Error("the capture reader is a platform admin — the unbound-run control would be vacuous");
}

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
  unboundOwnerUserId: otherUserId,
  readerRole,
  rows: back.rows,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("SEEDED RUNS OK");
