// Provision the throwaway account, organization and template ids this lane's
// walk runs as, on the lane's own disposable dev stack.
//
// NO IDENTITY IS WRITTEN DOWN HERE, on purpose. The sign-in address, the
// password and the display name are read from the environment and have no
// literal default: a checked-in address is an address, whatever domain it
// carries, and a checked-in password field is worth nothing to a reader and
// something to a scraper. Every one of them is disposable and belongs to a
// database that is dropped when the lane ends. Missing input FAILS rather than
// falling back to a guess, so nobody discovers the fallback by running this
// against something that is not a lane.
import { Client } from "pg";
import fs from "node:fs";
const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const DISPLAY_NAME = process.env.LANE_DISPLAY_NAME;
const ORG_NAME = process.env.LANE_ORG_NAME;
const ORG_SLUG = process.env.LANE_ORG_SLUG;
const DB = process.env.SUPABASE_DB_URL;
for (const [name, value] of Object.entries({
  WALK_BASE: BASE,
  LANE_ACCOUNT: EMAIL,
  LANE_SECRET: PASSWORD,
  LANE_DISPLAY_NAME: DISPLAY_NAME,
  LANE_ORG_NAME: ORG_NAME,
  LANE_ORG_SLUG: ORG_SLUG,
  SUPABASE_DB_URL: DB,
})) {
  if (!value) throw new Error(`lane-setup needs ${name} in the environment`);
}
const H = { Origin: BASE, "Content-Type": "application/json" };
const jar = new Map();
function capture(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";"); const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { ...H, Cookie: cookieHeader() }, body: JSON.stringify(body) });
  capture(res); return res;
}
console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: DISPLAY_NAME })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);
const client = new Client({ connectionString: DB });
await client.connect();
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;
const orgsRes = await fetch(BASE + "/api/auth/organization/list", { headers: { ...H, Cookie: cookieHeader() } });
const orgs = await orgsRes.json();
let orgId = Array.isArray(orgs) && orgs[0]?.id;
if (!orgId) {
  const cr = await post("/api/auth/organization/create", { name: ORG_NAME, slug: ORG_SLUG });
  console.log("org create", cr.status); orgId = (await cr.json())?.id;
}
await post("/api/auth/organization/set-active", { organizationId: orgId });
const tpl = await client.query(`SELECT id, package_name FROM cinatra.agent_templates WHERE package_name = '@cinatra-ai/blog-draft-writer-agent' LIMIT 1`);
await client.end();
const out = { orgId, userId, templateId: tpl.rows[0]?.id ?? null, templatePkg: tpl.rows[0]?.package_name ?? null, cookie: cookieHeader() };
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templateId: out.templateId, templatePkg: out.templatePkg }, null, 2));
