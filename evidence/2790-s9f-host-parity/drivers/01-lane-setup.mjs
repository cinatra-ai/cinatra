// cinatra#2790 S9f capture lane, step 1 — the lane's own owner + organization,
// through the SHIPPED Better Auth routes. Adapted from
// evidence/2841-v-redraw/drivers/lane-setup.mjs (same shape, this lane's port
// and database).
//
// Nothing here writes an identity row by hand: the account and the organization
// are created by the routes the sign-up and organization surfaces themselves
// call. The one direct write is the `role='admin'` promotion the 2841 lane also
// made — lane data, not code.
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
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { ...H, Cookie: cookieHeader() },
    body: JSON.stringify(body),
  });
  capture(res);
  return res;
}

console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: "S9f Capture Owner" })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);

const client = new Client({ connectionString: DB });
await client.connect();
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;

const orgsRes = await fetch(BASE + "/api/auth/organization/list", { headers: { ...H, Cookie: cookieHeader() } });
const orgs = await orgsRes.json();
let orgId = Array.isArray(orgs) && orgs[0]?.id;
if (!orgId) {
  const cr = await post("/api/auth/organization/create", { name: "S9f Capture Org", slug: "s9f-capture-org" });
  console.log("org create", cr.status);
  orgId = (await cr.json())?.id;
}
await post("/api/auth/organization/set-active", { organizationId: orgId });

// LANE REPAIR, stated in the README: the cloned fixture's
// `agent_templates.org_id` points at an organization row that does not exist in
// this database, so every reader outside it is refused `cross_org` and the
// post-decision dispatch is refused. Repointed to THIS lane's organization.
// Lane data, never code: it changes who may open the run, never what is drawn.
const tpl = await client.query(
  `SELECT id, package_name, org_id FROM cinatra.agent_templates WHERE package_name = $1 LIMIT 1`,
  [process.env.WALK_TEMPLATE_PKG],
);
const before = tpl.rows[0]?.org_id ?? null;
await client.query(`UPDATE cinatra.agent_templates SET org_id=$1 WHERE id=$2`, [orgId, tpl.rows[0].id]);
console.log(`template org_id repointed: ${before === orgId ? "(already this org)" : "repointed to the lane org"}`);

// The stray-organization check the 2841 round had to make by hand: report every
// organization so a second `Default` seeded by an RBAC fixture cannot go unseen.
const allOrgs = await client.query(`SELECT id, name, slug FROM public.organization ORDER BY name`);
console.log("organizations present:", JSON.stringify(allOrgs.rows.map((r) => r.name)));

await client.end();

const out = { orgId, userId, templateId: tpl.rows[0]?.id ?? null, templatePkg: tpl.rows[0]?.package_name ?? null, cookie: cookieHeader() };
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templateId: out.templateId, templatePkg: out.templatePkg }, null, 2));
