// Provision the throwaway account, organization and template ids this lane's
// walk runs as, on the lane's own disposable dev stack.
//
// NO IDENTITY IS WRITTEN DOWN HERE, on purpose. The sign-in address, the
// password and the display name are read from the environment and have no
// literal default: every one of them is disposable and belongs to a database
// that is dropped when the lane ends. Missing input FAILS rather than falling
// back to a guess.
//
// Adapted from evidence/2893-zero-chip-settled/drivers/lane-setup.mjs, which is
// the shape every recent capture lane provisions with.
import { Client } from "pg";
import fs from "node:fs";
const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const DISPLAY_NAME = process.env.LANE_DISPLAY_NAME;
const ORG_NAME = process.env.LANE_ORG_NAME;
const ORG_SLUG = process.env.LANE_ORG_SLUG;
const PKG = process.env.LANE_TEMPLATE_PACKAGE;
const DB = process.env.SUPABASE_DB_URL;
for (const [name, value] of Object.entries({
  WALK_BASE: BASE,
  LANE_ACCOUNT: EMAIL,
  LANE_SECRET: PASSWORD,
  LANE_DISPLAY_NAME: DISPLAY_NAME,
  LANE_ORG_NAME: ORG_NAME,
  LANE_ORG_SLUG: ORG_SLUG,
  LANE_TEMPLATE_PACKAGE: PKG,
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
// Administrator, because §VI's settled chrome draws `Release now` for one and
// the capture has to show the control the drawing gives an administrator.
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;
// THE ORGANIZATION IS THE ONE THE TEMPLATE BELONGS TO, not a fresh one.
// A proposal is refused outright for a template outside the caller's active
// organization (`mintProposal`: "the org boundary, before anything confirms the
// template exists to a caller outside it"), and the dev instance's own boot
// import stamps every agent template with the bootstrap organization. So the
// lane account JOINS that organization instead of standing up a second one —
// the membership row is written straight into Better Auth's own table, which is
// lane provisioning, not a product path being stood in for.
const tplRow = (
  await client.query(`SELECT id, package_name, org_id FROM cinatra.agent_templates WHERE package_name = $1 LIMIT 1`, [PKG])
).rows[0];
if (!tplRow) throw new Error(`no agent template for ${PKG} on this lane`);
let orgId = tplRow.org_id;
if (!orgId) {
  const cr = await post("/api/auth/organization/create", { name: ORG_NAME, slug: ORG_SLUG });
  console.log("org create", cr.status);
  orgId = (await cr.json())?.id;
} else {
  const existing = await client.query(
    `SELECT id FROM public.member WHERE "organizationId" = $1 AND "userId" = $2`,
    [orgId, userId],
  );
  if (existing.rowCount === 0) {
    await client.query(
      `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    console.log("membership written into the template's organization");
  }
}
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: orgId })).status);
await client.end();
const out = {
  orgId,
  userId,
  templateId: tplRow.id,
  templatePkg: tplRow.package_name,
  cookie: cookieHeader(),
};
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templateId: out.templateId, templatePkg: out.templatePkg }, null, 2));
