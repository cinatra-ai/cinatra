// THE LANE'S OWN ACCOUNT, minted through the app's SHIPPED sign-up route, and
// made a member of the ONE organization the instance's own boot import stamped
// every agent template with.
//
// It replaces the 01 + 02 pair for this round for one reason worth recording:
// 01 CREATED a second organization before 02 joined the template's one, and a
// second organization is a lane artefact that a picture of the product should
// never carry. This driver creates none — it joins the organization that is
// already there, and refuses if the instance does not have exactly one.
//
// No identity is written down here: every value comes from the environment.
// The ONE direct-SQL write is disclosed in the README (the admin role + the
// Better Auth membership row); nothing it touches is a run, a trigger, a gate
// or a record.
import { Client } from "pg";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const NAME = process.env.LANE_ACCOUNT_NAME;
const DB = process.env.SUPABASE_DB_URL;
const OUT = process.env.OUT_JSON;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD, LANE_ACCOUNT_NAME: NAME, SUPABASE_DB_URL: DB, OUT_JSON: OUT }))
  if (!v) throw new Error(`lane-identity needs ${n}`);

const H = { Origin: BASE, "Content-Type": "application/json" };
const jar = new Map();
function capture(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { ...H, Cookie: cookieHeader() }, body: JSON.stringify(body) });
  capture(res);
  return res;
}

console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: NAME })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);

const client = new Client({ connectionString: DB });
await client.connect();
// The setup and configuration screens this lane walks (/setup/model,
// /configuration/development) are admin-gated.
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;
const orgs = (await client.query(`SELECT id, name FROM public.organization ORDER BY name`)).rows;
if (orgs.length !== 1) throw new Error(`expected exactly one organization on the instance, found ${orgs.length}`);
const orgId = orgs[0].id;
const templateOrgs = (await client.query(`SELECT DISTINCT org_id FROM cinatra.agent_templates WHERE org_id IS NOT NULL`)).rows.map((r) => r.org_id);
if (templateOrgs.length !== 1 || templateOrgs[0] !== orgId)
  throw new Error(`the templates do not all belong to the one organization (${JSON.stringify(templateOrgs)})`);
const already = (await client.query(`SELECT id FROM public.member WHERE "organizationId"=$1 AND "userId"=$2`, [orgId, userId])).rows[0];
if (!already) {
  await client.query(
    `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt") VALUES ($1,$2,$3,'owner',now())`,
    [randomUUID(), orgId, userId],
  );
}
console.log("membership:", already ? "already a member" : "made an owner of the instance's one organization");
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: orgId })).status);
await client.end();
fs.writeFileSync(OUT, `${JSON.stringify({ orgId, userId, cookie: cookieHeader() }, null, 2)}\n`);
console.log(JSON.stringify({ orgId, userId }, null, 2));
