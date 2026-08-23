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

// THE READER IS DEMOTED AGAIN, AND THE CONTROL DEPENDS ON IT.
//
// The `admin` role above exists for ONE reason: the first account has to create
// the organization through the shipped route. But `admin` is PLATFORM admin, and
// platform-admin is a rung of the very authorization ladder this capture's
// negative control is supposed to fail on (`readAgentRunById`: owner / co-owner /
// same-org / platform-admin). A platform admin is ENTITLED to a run in another
// organization, so the "unbound" run answers 200 and the control proves nothing —
// measured exactly that way on 2026-08-22 before this line existed.
//
// So the capture's reader ends as an ordinary member: their own run is theirs by
// ownership, and another tenant's run is out of reach on the shipped ladder
// rather than by anything this driver arranged.
await client.query(`UPDATE public."user" SET role='user' WHERE email=$1`, [EMAIL]);
const finalRole = (await client.query(`SELECT role FROM public."user" WHERE email=$1`, [EMAIL])).rows[0]?.role;
console.log(`capture reader role after setup: ${finalRole}`);
if (finalRole === "admin") throw new Error("the capture reader is still a platform admin — the unbound-run control would be vacuous");
await client.end();

// The session cookie is NOT serialized. It is a live credential for the
// capture's signed-in reader, and an intermediate artifact is exactly the file
// that gets
// pasted into an issue or swept into evidence by accident. The capture recorder
// already sets the standard this follows: it records a cookie's NAME and flags
// and never its value (`cookieJar` in capture-results.json). Downstream drivers
// sign in themselves and hold their own jar, so nothing reads this field.
// Presence markers keep the diagnostic value — "did setup end signed in" — with
// nothing to steal.
const out = {
  orgId,
  userId,
  readerRole: finalRole,
  templates: tpl.rows,
  sessionCookie: jar.size > 0 ? "present" : "absent",
  sessionCookieNames: [...jar.keys()],
};
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templates: tpl.rows.map(r => r.package_name) }, null, 2));
