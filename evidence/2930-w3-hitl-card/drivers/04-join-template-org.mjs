// The lane account JOINS the organization the dev instance's own boot import
// stamped every agent template with, rather than standing up a second one: a
// run proposal is refused outright for a template outside the caller's active
// organization. The membership row is written straight into Better Auth's own
// table — lane provisioning, not a product path being stood in for. This is
// DISCLOSED direct-SQL lane write #2; README.md carries it.
import { Client } from "pg";
import fs from "node:fs";
const BASE = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const ident = JSON.parse(fs.readFileSync(process.env.OUT_JSON, "utf8"));
const client = new Client({ connectionString: DB });
await client.connect();
const orgIds = (await client.query(`SELECT DISTINCT org_id FROM cinatra.agent_templates WHERE org_id IS NOT NULL`)).rows.map((r) => r.org_id);
if (orgIds.length !== 1) throw new Error(`expected one template organization, saw ${orgIds.length}`);
const templateOrg = orgIds[0];
const existing = await client.query(`SELECT id FROM public.member WHERE "organizationId" = $1 AND "userId" = $2`, [templateOrg, ident.userId]);
if (existing.rowCount === 0) {
  await client.query(
    `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'owner', now())`,
    [templateOrg, ident.userId],
  );
  console.log("membership written into the template's organization");
}
await client.end();
const jar = new Map();
const capture = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const si = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET }) });
capture(si);
console.log("sign-in", si.status);
const res = await fetch(BASE + "/api/auth/organization/set-active", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json", Cookie: cookieHeader() }, body: JSON.stringify({ organizationId: templateOrg }) });
console.log("set-active", res.status);
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify({ ...ident, laneOrgId: ident.orgId, orgId: templateOrg }, null, 2));
console.log(JSON.stringify({ templateOrg }, null, 2));
