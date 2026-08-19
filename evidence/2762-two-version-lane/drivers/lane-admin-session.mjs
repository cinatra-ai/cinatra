// -----------------------------------------------------------------------------
// Mint a platform-admin operator with an active organization on the lane
// database, so the admin-gated marketplace and settings routes render.
//
// This is the repo's own e2e recipe (tests/e2e/marketplace-install/auth.setup.ts)
// expressed as a plain script, because this proof drives a real browser rather
// than Playwright. The ORDER is the load-bearing part and is kept exactly:
// create the user, grant the role and the organization membership, and only
// THEN sign in. A role granted after sign-in is invisible to the cached
// session, so every admin route would answer with a redirect instead.
//
// Usage:
//   node lane-admin-session.mjs <appOrigin> <databaseUrl> <email> <password>
import { Client } from "pg";

const [origin, databaseUrl, email, password] = process.argv.slice(2);
if (!origin || !databaseUrl || !email || !password) {
  console.error("usage: lane-admin-session.mjs <appOrigin> <databaseUrl> <email> <password>");
  process.exit(2);
}

const headers = { "content-type": "application/json", Origin: origin };

// 1. Create the user. Already-present is a success for this script's purpose,
//    so the run is repeatable.
const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password, name: "Two-Version Proof Admin" }),
});
console.log("sign-up status:", signUp.status);
if (![200, 400, 422].includes(signUp.status)) {
  console.error("unexpected sign-up status:", await signUp.text());
  process.exit(1);
}

// 2. Grant platform admin and an organization membership BEFORE the sign-in
//    whose session is used.
const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
await client.connect();
let organizationId;
try {
  const found = await client.query('SELECT id FROM public."user" WHERE email = $1 LIMIT 1', [email]);
  if (found.rowCount === 0) throw new Error(`user not found after sign-up: ${email}`);
  const userId = found.rows[0].id;

  // Append rather than overwrite: the role column is a comma-separated list.
  await client.query(
    `UPDATE public."user"
        SET role = CASE
          WHEN role IS NULL OR btrim(role) = '' THEN 'admin'
          WHEN 'admin' = ANY (regexp_split_to_array(role, '\\s*,\\s*')) THEN role
          ELSE role || ',admin'
        END
      WHERE id = $1`,
    [userId],
  );

  const member = await client.query(
    'SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1',
    [userId],
  );
  if (member.rowCount > 0) {
    organizationId = member.rows[0].organizationId;
  } else {
    organizationId = `two-version-proof-org`;
    await client.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [organizationId, "Two-Version Proof Org", organizationId],
    );
    await client.query(
      `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
      [`two-version-proof-member`, userId, organizationId],
    );
  }
  console.log("userId:", userId, "organizationId:", organizationId);
} finally {
  await client.end();
}

// 3. Sign in. The session now carries the admin role.
const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password }),
});
console.log("sign-in status:", signIn.status);
if (!signIn.ok) {
  console.error(await signIn.text());
  process.exit(1);
}

// 4. Set the active organization. The install access-target picker reads it.
const cookie = (signIn.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .join("; ");
const setActive = await fetch(`${origin}/api/auth/organization/set-active`, {
  method: "POST",
  headers: { ...headers, cookie },
  body: JSON.stringify({ organizationId }),
});
console.log("set-active status:", setActive.status);
console.log("READY: sign in through the browser at", `${origin}/sign-in`, "as", email);
