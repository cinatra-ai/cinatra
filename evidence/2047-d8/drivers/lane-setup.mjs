import { Client } from "pg";
import fs from "node:fs";
const BASE = "http://localhost:3149";
const EMAIL = "lane-2047-d8@local.test";
const PASSWORD = process.env.LANE_PW; // lane-scoped, never committed
const DB = process.env.SUPABASE_DB_URL;
const H = { Origin: BASE, "Content-Type": "application/json" };
const jar = new Map();
function capture(res) { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function post(path, body) { const res = await fetch(BASE + path, { method: "POST", headers: { ...H, Cookie: cookieHeader() }, body: JSON.stringify(body) }); capture(res); return res; }
console.log("sign-up", (await post("/api/auth/sign-up/email", { email: EMAIL, password: PASSWORD, name: "Lane 2047 D8" })).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })).status);
const client = new Client({ connectionString: DB });
await client.connect();
await client.query(`UPDATE public."user" SET role='admin' WHERE email=$1`, [EMAIL]);
const userId = (await client.query(`SELECT id FROM public."user" WHERE email=$1`, [EMAIL])).rows[0].id;
const orgsRes = await fetch(BASE + "/api/auth/organization/list", { headers: { ...H, Cookie: cookieHeader() } });
const orgs = await orgsRes.json();
let orgId = Array.isArray(orgs) && orgs[0]?.id;
if (!orgId) { const cr = await post("/api/auth/organization/create", { name: "Lane 2047 D8 Org", slug: "lane-2047-d8-org" }); console.log("org create", cr.status); orgId = (await cr.json())?.id; }
await post("/api/auth/organization/set-active", { organizationId: orgId });
const tpl = await client.query(`SELECT id, package_name FROM cinatra.agent_templates WHERE package_name = '@cinatra-ai/blog-draft-writer-agent' LIMIT 1`);
await client.end();
const out = { orgId, userId, templateId: tpl.rows[0]?.id ?? null, templatePkg: tpl.rows[0]?.package_name ?? null, cookie: cookieHeader() };
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ orgId, userId, templateId: out.templateId, templatePkg: out.templatePkg }, null, 2));
