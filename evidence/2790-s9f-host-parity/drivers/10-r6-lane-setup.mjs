// ---------------------------------------------------------------------------
// cinatra#2790 S9f — R6 RE-SHOOT, step 1: the lane's own owner, through the
// SHIPPED Better Auth routes.
//
// It differs from `01-lane-setup.mjs` in ONE way, and the difference is a lane
// repair the previous round had to make by hand AFTERWARDS: it never creates a
// second organization. The platform's own `ensureDefaultOrganizationMembership`
// adopts a platform admin into the `slug="default"` organization on session
// bootstrap, and the cloned lane database already carries that organization as
// the one the agent template belongs to. `01` called `organization/create`
// before that adoption had run, produced a second organization, and the round
// then deleted it as lane data. Here the adoption is simply WAITED FOR, and the
// run refuses if more than one organization ends up existing.
//
// Nothing writes an identity row by hand except the `role='admin'` promotion the
// 2841 lane also made — lane data, not code.
//
// Usage: node 10-r6-lane-setup.mjs
//        env: WALK_BASE, LANE_EMAIL, LANE_PW, SUPABASE_DB_URL, WALK_TEMPLATE_PKG,
//             OUT_JSON
// ---------------------------------------------------------------------------
import { Client } from "pg";
import fs from "node:fs";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PW; // lane-scoped, never committed
const DB = process.env.SUPABASE_DB_URL;
if (!BASE || !EMAIL || !PASSWORD || !DB) throw new Error("set WALK_BASE, LANE_EMAIL, LANE_PW, SUPABASE_DB_URL");
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
async function get(path) {
  const res = await fetch(BASE + path, { headers: { ...H, Cookie: cookieHeader() } });
  capture(res);
  return res;
}

console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: "S9f R6 Capture Owner" })).status);

const client = new Client({ connectionString: DB });
await client.connect();
// The promotion has to land BEFORE the session that must be adopted, because
// the adoption only fires for a platform admin.
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;

console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);
// The bootstrap runs on a real app request, not on the auth route, so ask for a
// page and then read the membership back out of the database.
await get("/agents");

let orgId = null;
for (let i = 0; i < 30; i += 1) {
  const rows = (await client.query(`SELECT "organizationId" FROM public.member WHERE "userId"=$1`, [userId])).rows;
  if (rows.length) { orgId = rows[0].organizationId; break; }
  await get("/agents");
  await new Promise((r) => setTimeout(r, 2000));
}
if (!orgId) throw new Error("the platform never adopted this admin into an organization");
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: orgId })).status);

const allOrgs = (await client.query(`SELECT id, name, slug FROM public.organization ORDER BY name`)).rows;
console.log("organizations present:", JSON.stringify(allOrgs.map((r) => `${r.name}/${r.slug}`)));
if (allOrgs.length !== 1) throw new Error(`expected exactly ONE organization in this lane, found ${allOrgs.length}`);

const tpl = (await client.query(
  `SELECT id, package_name, org_id FROM cinatra.agent_templates WHERE package_name = $1 LIMIT 1`,
  [process.env.WALK_TEMPLATE_PKG],
)).rows[0];
if (!tpl) throw new Error(`no agent_templates row for ${process.env.WALK_TEMPLATE_PKG}`);
// The run picker needs the ACTOR'S ACTIVE ORGANIZATION to own the template.
if (tpl.org_id !== orgId) {
  await client.query(`UPDATE cinatra.agent_templates SET org_id=$1 WHERE id=$2`, [orgId, tpl.id]);
  console.log("template org_id repointed to the lane organization");
} else {
  console.log("template org_id: already this organization");
}
await client.end();

const out = { orgId, userId, templateId: tpl.id, templatePkg: tpl.package_name, cookie: cookieHeader() };
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templateId: out.templateId, templatePkg: out.templatePkg }, null, 2));
