// Collapse the lane to ONE organization: the instance's own `Default` org that
// `pnpm setup:dev` bootstrapped. `asset-blog` is single-tenant and refuses to
// resolve an owner while two organizations exist, so the lane account joins the
// existing organization instead of creating a second one.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

const DB = process.env.SUPABASE_DB_URL;
const BASE = process.env.WALK_BASE;
const EMAIL = process.env.LANE_EMAIL;
const PASSWORD = process.env.LANE_PW;
const c = new Client({ connectionString: DB });
await c.connect();
const keep = (await c.query(`select id from public.organization where slug='default'`)).rows[0].id;
const userId = (await c.query(`select id from public."user" where email=$1`, [EMAIL])).rows[0].id;
await c.query(`delete from public.member where "organizationId" <> $1 and "userId"=$2`, [keep, userId]);
await c.query(`delete from public.organization where id <> $1`, [keep]);
await c.query(
  `insert into public.member (id, "organizationId", "userId", role, "createdAt")
   values ($1,$2,$3,'owner',now())
   on conflict do nothing`,
  [randomUUID(), keep, userId],
);
console.log("orgs", (await c.query(`select id,slug from public.organization`)).rows);
await c.end();

const H = { Origin: BASE, "Content-Type": "application/json" };
const jar = new Map();
const capture = (res) => {
  for (const s of res.headers.getSetCookie?.() ?? []) {
    const [kv] = s.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { ...H, Cookie: cookieHeader() }, body: JSON.stringify(b) });
  capture(r);
  return r;
};
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: keep })).status);

const ids = JSON.parse(fs.readFileSync(process.env.OUT_JSON, "utf8"));
ids.orgId = keep;
ids.userId = userId;
ids.cookie = cookieHeader();
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(ids, null, 2));
console.log(JSON.stringify({ orgId: keep, userId }));
