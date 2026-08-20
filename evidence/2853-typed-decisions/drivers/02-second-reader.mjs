// ---------------------------------------------------------------------------
// The RESTRICTED READER — a second real account in the same organization.
//
// The account is made by the SHIPPED Better Auth sign-up route, and it is
// signed in through the shipped sign-in route, so the session the capture
// drives with is a real one. What is written by hand is exactly ONE thing, and
// it is named here rather than buried: the `public.member` row that puts the
// new account in the org. That is membership plumbing, not the mechanism under
// proof — the thing this round measures is what the composer does with a typed
// decision when the RUN POLICY denies the reader, and that policy is the run's
// own `auth_policy`, written as a column of the run insert in `walk.test.ts`.
//
// The reader is a PLAIN MEMBER. It holds `run.approveHitl` by role, exactly
// like any other member; what stops it is the run's execute-tier visibility.
// That matters: a reader denied by role would prove much less, because the
// interesting case is the one where the kernel says yes and the run's own
// configuration says no.
//
// Usage: node 02-second-reader.mjs <baseUrl> <orgId> <outJson>
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

const BASE = process.argv[2];
const ORG = process.argv[3];
const OUT = process.argv[4];
const DB = process.env.SUPABASE_DB_URL;

const ACTOR = {
  name: "2853 Restricted Reader",
  email: process.env.READER_EMAIL ?? "typed-2853-reader@example.com",
  password: process.env.READER_PW ?? "typed-2853-reader-dev-12345",
};

const jar = new Map();
const capture = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json", Cookie: cookieHeader() },
    body: JSON.stringify(body),
  });
  capture(res);
  return res;
}

console.log("sign-up", (await post("/api/auth/sign-up/email", ACTOR)).status);
console.log("sign-in", (await post("/api/auth/sign-in/email", { email: ACTOR.email, password: ACTOR.password })).status);

const db = new Client({ connectionString: DB });
await db.connect();
const userId = (await db.query(`SELECT id FROM public."user" WHERE email=$1`, [ACTOR.email])).rows[0].id;
// THE ONE HAND-WRITTEN ROW, and it is org membership only.
await db.query(
  `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
   VALUES ($1,$2,$3,'member',now())
   ON CONFLICT DO NOTHING`,
  [randomUUID(), ORG, userId, ],
);
const back = await db.query(
  `SELECT m.role FROM public.member m WHERE m."organizationId"=$1 AND m."userId"=$2`,
  [ORG, userId],
);
await db.end();
console.log("member role:", JSON.stringify(back.rows));

// The session must have this org ACTIVE — the review actor reads
// `session.activeOrganizationId` and resolves nothing without it.
console.log("set-active", (await post("/api/auth/organization/set-active", { organizationId: ORG })).status);

fs.writeFileSync(OUT, JSON.stringify({ userId, email: ACTOR.email, cookie: cookieHeader() }, null, 2));
console.log("reader userId", userId);
