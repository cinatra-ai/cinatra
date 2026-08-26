// The lane account JOINS the organization the dev instance's own boot import
// stamped every agent template with, rather than standing up a second one: a
// run proposal is refused outright for a template outside the caller's active
// organization. The membership row is written straight into Better Auth's own
// table — lane provisioning, not a product path being stood in for. This is the
// lane's ONLY direct-SQL write, and README.md discloses it.
import { Client } from "pg";
import fs from "node:fs";
const BASE = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const ident = JSON.parse(fs.readFileSync(process.env.OUT_JSON, "utf8"));
const client = new Client({ connectionString: DB });
await client.connect();
const orgId = (
  await client.query(`SELECT DISTINCT org_id FROM cinatra.agent_templates WHERE org_id IS NOT NULL`)
).rows.map((r) => r.org_id);
if (orgId.length !== 1) throw new Error(`expected one template organization, saw ${orgId.length}`);
const templateOrg = orgId[0];
const existing = await client.query(
  `SELECT id FROM public.member WHERE "organizationId" = $1 AND "userId" = $2`,
  [templateOrg, ident.userId],
);
if (existing.rowCount === 0) {
  await client.query(
    `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'owner', now())`,
    [templateOrg, ident.userId],
  );
  console.log("membership written into the template's organization");
}
await client.end();
const res = await fetch(BASE + "/api/auth/organization/set-active", {
  method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json", Cookie: ident.cookie },
  body: JSON.stringify({ organizationId: templateOrg }),
});
console.log("set-active", res.status);
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify({ ...ident, orgId: templateOrg }, null, 2));
console.log(JSON.stringify({ templateOrg }, null, 2));
