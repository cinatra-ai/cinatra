// Lane setup: first-admin signup + org through the SHIPPED Better-Auth routes.
// Adapted from evidence/2047-flip/drivers/lane-setup.mjs.
import { Client } from "pg";
import fs from "node:fs";

const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PW;
const DB = process.env.SUPABASE_DB_URL;
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

console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: process.env.LANE_NAME ?? "Lane Capture" })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);

const client = new Client({ connectionString: DB });
await client.connect();
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;

const orgsRes = await fetch(BASE + "/api/auth/organization/list", { headers: { ...H, Cookie: cookieHeader() } });
let orgs = [];
try { orgs = await orgsRes.json(); } catch {}
let orgId = Array.isArray(orgs) && orgs[0]?.id;
if (!orgId) {
  const cr = await post("/api/auth/organization/create", { name: process.env.LANE_ORG_NAME, slug: process.env.LANE_ORG_SLUG });
  console.log("org create", cr.status);
  orgId = (await cr.json())?.id;
}
await post("/api/auth/organization/set-active", { organizationId: orgId });

const tpl = await client.query(
  `SELECT id, package_name FROM cinatra.agent_templates ORDER BY package_name LIMIT 20`,
);
await client.end();

const out = { orgId, userId, templates: tpl.rows, cookie: cookieHeader() };
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templates: tpl.rows.map(r => r.package_name) }, null, 2));
