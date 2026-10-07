/**
 * Auth setup for the steps smoke, on the same pattern as the other suites:
 *
 *   1. open registration for fixtures (a fresh instance keeps it closed);
 *   2. sign the smoke account up through the auth API (idempotent);
 *   3. grant it the admin role through the database, so it may create an
 *      organization;
 *   4. sign it in through the auth API;
 *   5. make sure it has an organization;
 *   6. save the cookie state for the smokes that start signed in.
 *
 * The sign-in smoke does not use this session: it signs the same account in
 * through the page, in a context of its own. The auth API needs an `Origin`
 * header on every state-changing call, so each call sends one.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { expect, test as setup } from "@playwright/test";
import { Client } from "pg";

import { openRegistrationForFixtures } from "../../open-registration";
import { STEPS_CREDENTIALS, STEPS_STORAGE_STATE, readinessGap } from "./readiness";

const DATABASE_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";

const gap = readinessGap();
setup.skip(gap !== null, gap ?? "");

async function grantAdminRoleByEmail(email: string): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`UPDATE public."user" SET role = 'admin' WHERE email = $1 AND COALESCE(role, '') != 'admin'`, [email]);
  } finally {
    await client.end();
  }
}

setup("create the smoke account and save its session", async ({ request, baseURL }) => {
  const headers = { Origin: baseURL ?? "" };
  await openRegistrationForFixtures({ databaseUrl: DATABASE_URL });

  // Idempotent sign-up: 200 for a new account, 400 or 422 for one that exists.
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { ...STEPS_CREDENTIALS, name: "Steps Smoke" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // The admin role, before the sign-in whose session is saved.
  await grantAdminRoleByEmail(STEPS_CREDENTIALS.email);

  // Sign in.
  const signIn = await request.post("/api/auth/sign-in/email", { data: STEPS_CREDENTIALS, headers });
  expect(signIn.ok()).toBeTruthy();

  // An organization, so the signed-in app shell renders.
  const organizations = await request.get("/api/auth/organization/list", { headers });
  expect(organizations.ok()).toBeTruthy();
  const listed = await organizations.json();
  if (!Array.isArray(listed) || listed.length === 0) {
    const created = await request.post("/api/auth/organization/create", {
      data: { name: "Steps Smoke Org", slug: "steps-smoke-org" },
      headers,
    });
    expect(created.ok(), `organization/create answered ${created.status()}`).toBeTruthy();
  }

  // The session, for the smokes that start signed in.
  mkdirSync(dirname(STEPS_STORAGE_STATE), { recursive: true });
  await request.storageState({ path: STEPS_STORAGE_STATE });
});
