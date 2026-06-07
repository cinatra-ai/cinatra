/**
 * Auth setup for the `/agents/run` UAT harness.
 *
 * Steps:
 *   1. Idempotent sign-up via Better Auth.
 *   2. Sign-in.
 *   3. Direct-pg `UPDATE public."user" SET role='admin'`. This
 *      avoids the one-time manual SQL grant that would otherwise be
 *      required.
 *   4. Ensure active organization (creates if none).
 *   5. Persist cookie state for the agents-run project.
 *
 * Better Auth's state-changing endpoints require an `Origin` header.
 * Set on every request for uniform safety.
 *
 * Direct-pg access mirrors `tests/e2e/dashboards/seed-data.ts`. The
 * connection string defaults to the canonical cinatra DB but can be
 * overridden via `SUPABASE_DB_URL` env (matches the dev server's
 * resolution).
 */
import { expect, test as setup } from "@playwright/test";
import { Client } from "pg";

const EMAIL = process.env.E2E_AGENTS_RUN_USER_EMAIL ?? "agents-run-uat@local.test";
const PASSWORD = process.env.E2E_AGENTS_RUN_USER_PASSWORD ?? "AgentsRunUAT2026!";
const BASE_URL = process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000";
const STORAGE_PATH = "tests/e2e/agents-run/.auth/state.json";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

const COMMON_HEADERS = { Origin: BASE_URL } as const;

async function grantAdminRoleByEmail(email: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    // Idempotent: no-op if user doesn't exist yet (Better Auth sign-up
    // hasn't been processed in some flows). We run this after sign-up
    // but before org-create, when the user row is guaranteed to exist.
    await client.query(
      `UPDATE public."user" SET role = 'admin' WHERE email = $1 AND COALESCE(role, '') != 'admin'`,
      [email],
    );
  } finally {
    await client.end();
  }
}

/**
 * Clone Gmail OAuth from any connected admin user to
 * the test user so email-delivery / email-outreach / email-test-delivery
 * fixtures can resolve a Gmail sender. The connector keys OAuth per
 * userId — without this, the agents throw "No Gmail sender account is
 * connected" before the dev recipient override fires.
 *
 * Idempotent: if the test user already has a Gmail account row, skip.
 * If no source admin has a Gmail row, log + skip — Gmail-dependent
 * fixtures will simply fail the same way as before.
 *
 * The cloned `account` row's id is namespaced (`cloned-uat-` prefix) so
 * a real OAuth flow on the test user wouldn't collide.
 */
async function cloneGmailOAuthFromAnyAdmin(testUserEmail: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const testUserRes = await client.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [testUserEmail],
    );
    if (testUserRes.rowCount === 0) return; // user doesn't exist yet
    const testUserId = testUserRes.rows[0].id;

    // Already cloned?
    const existing = await client.query(
      `SELECT 1 FROM public.account WHERE "userId" = $1 AND "providerId" = 'google'`,
      [testUserId],
    );
    if (existing.rowCount && existing.rowCount > 0) return;

    // Pick any admin with a connected Google account.
    const srcRes = await client.query<{ id: string }>(
      `SELECT a."userId" AS id
       FROM public.account a
       JOIN public."user" u ON u.id = a."userId"
       WHERE a."providerId" = 'google'
         AND u.role = 'admin'
       ORDER BY a."updatedAt" DESC NULLS LAST
       LIMIT 1`,
    );
    if (srcRes.rowCount === 0) {
      // No source admin has Gmail — fixture failure will be clear.
      return;
    }
    const srcUserId = srcRes.rows[0].id;

    // 1. Clone the better-auth `account` row so accessToken/refreshToken
    //    are visible to the test user.
    await client.query(
      `INSERT INTO public.account
         (id, "accountId", "providerId", "userId",
          "accessToken", "refreshToken", "idToken",
          "accessTokenExpiresAt", "refreshTokenExpiresAt",
          scope, password, "createdAt", "updatedAt")
       SELECT 'cloned-uat-' || $2,
              "accountId", "providerId", $1,
              "accessToken", "refreshToken", "idToken",
              "accessTokenExpiresAt", "refreshTokenExpiresAt",
              scope, password, now(), now()
         FROM public.account
        WHERE "userId" = $2 AND "providerId" = 'google'
       ON CONFLICT (id) DO NOTHING`,
      [testUserId, srcUserId],
    );

    // 2. Clone the cinatra-side gmail_user metadata row so sendAs
    //    aliases + synced settings are visible.
    await client.query(
      `INSERT INTO cinatra.metadata (key, value)
       SELECT 'connector_config:gmail_user:' || $1, value
         FROM cinatra.metadata
        WHERE key = 'connector_config:gmail_user:' || $2
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [testUserId, srcUserId],
    );
  } finally {
    await client.end();
  }
}

setup("create test user + save session", async ({ request }) => {
  // 1. Idempotent sign-up. Returns 200 for new users, 422 for existing.
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Agents Run UAT" },
    headers: COMMON_HEADERS,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // 2. Sign in.
  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers: COMMON_HEADERS,
  });
  expect(signIn.ok()).toBeTruthy();

  // 3. Auto-grant admin role via direct pg. Required by the
  //    project's `YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION`
  //    policy. Idempotent; no-op if already admin.
  await grantAdminRoleByEmail(EMAIL);

  // Clone Gmail OAuth + connector config from any
  // connected admin so Gmail-dependent fixtures (email-delivery /
  // email-outreach / email-test-delivery) can resolve a sender. The
  // dev recipient override redirects WHERE emails go; this step
  // resolves WHO sends them.
  await cloneGmailOAuthFromAnyAdmin(EMAIL);

  // 4. Ensure active organization.
  const orgs = await request.get("/api/auth/organization/list", {
    headers: COMMON_HEADERS,
  });
  expect(orgs.ok()).toBeTruthy();
  const orgsBody = await orgs.json();
  if (!Array.isArray(orgsBody) || orgsBody.length === 0) {
    const create = await request.post("/api/auth/organization/create", {
      data: { name: "Agents Run UAT Org", slug: "agents-run-uat-org" },
      headers: COMMON_HEADERS,
    });
    if (!create.ok()) {
      const body = await create.text();
      throw new Error(
        [
          `organization/create failed with ${create.status()}: ${body}`,
          `The admin-role auto-grant should have made this succeed. Manual fallback:`,
          `  UPDATE public."user" SET role='admin' WHERE email='${EMAIL}';`,
        ].join("\n"),
      );
    }
  }

  // 5. Persist cookie state.
  await request.storageState({ path: STORAGE_PATH });
});
