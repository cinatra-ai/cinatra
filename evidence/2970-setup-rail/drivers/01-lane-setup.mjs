// Provision the throwaway account + organization this lane's walk runs as, on
// the lane's own disposable database. No identity is written down here: every
// value comes from the environment. Adapted from
// evidence/2788-s9d-rework/drivers/lane-setup.mjs.
import { Client } from "pg";
import fs from "node:fs";
const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const DB = process.env.SUPABASE_DB_URL;
for (const [n, v] of Object.entries({ WALK_BASE: BASE, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD, SUPABASE_DB_URL: DB }))
  if (!v) throw new Error(`lane-setup needs ${n}`);
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
console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: "C7 Capture" })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);
const client = new Client({ connectionString: DB });
await client.connect();
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;
const cr = await post("/api/auth/organization/create", { name: process.env.LANE_ORG_NAME, slug: process.env.LANE_ORG_SLUG });
console.log("org create", cr.status);
const orgId = (await cr.json())?.id;
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: orgId })).status);
await client.end();
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify({ orgId, userId, cookie: cookieHeader() }, null, 2));
console.log(JSON.stringify({ orgId, userId }, null, 2));
