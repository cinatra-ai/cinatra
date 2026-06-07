/**
 * Auth + seed setup for the Release Workflows browser e2e.
 *
 * Runs once (Playwright "setup" project) before the chromium project:
 *   1. Sign up a deterministic test user (idempotent — 400 if it exists).
 *   2. Sign in to mint a session cookie.
 *   3. Ensure the session has an active organization.
 *   4. Seed a PAUSED, attempt-bearing workflow into that org (see seed-data.ts).
 *   5. Persist the cookie state for the chromium project.
 *
 * Better Auth's CSRF check requires an Origin header; Playwright's `request`
 * fixture sets it from `baseURL`, so these calls succeed where a bare curl
 * (mismatched origin) would 403.
 */
import { test as setup, expect } from "@playwright/test";

import { seedWorkflowFixtures, activateSessionsForUser } from "./seed-data";

const EMAIL = process.env.E2E_USER_EMAIL ?? "workflows-e2e@local.test";
const PASSWORD = process.env.E2E_USER_PASSWORD ?? "WorkflowsE2E2026!";
const STORAGE_PATH = "tests/e2e/workflows/.auth/state.json";

setup("create test user + seed paused workflow + save session", async ({ request }) => {
  // 1. Ensure the user exists (idempotent — 422 when already present).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Workflows E2E" },
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // 2. Seed BEFORE sign-in. Better Auth binds the membership list at sign-in
  //    time, so the org membership must already exist when the session is
  //    minted — otherwise set-active rejects an org the session can't "see".
  //    The seed bootstraps a dedicated org + owner membership via pg (org CREATE
  //    is API-restricted here) + the paused workflow.
  const seeded = await seedWorkflowFixtures({
    email: EMAIL,
    databaseUrl: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    schema: process.env.SUPABASE_SCHEMA ?? "cinatra",
  });
  expect(seeded.workflowId).toBeTruthy();

  // 3. Sign in to mint the session cookie.
  await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    failOnStatusCode: false,
  });
  const orgs = await request.get("/api/auth/organization/list");
  expect(orgs.ok(), "expected an authenticated session after sign-in").toBeTruthy();

  // 4. Point the session's ACTIVE org at the seeded org (the actor's tenant
  //    boundary). set-active is best-effort; writing session.activeOrganizationId
  //    directly is the deterministic mechanism (RSC reads it off the row).
  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: seeded.organizationId },
    failOnStatusCode: false,
  });
  const activated = await activateSessionsForUser({
    email: EMAIL,
    databaseUrl: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    schema: process.env.SUPABASE_SCHEMA ?? "cinatra",
    organizationId: seeded.organizationId,
  });
  expect(activated, "expected at least one session row activated for the seeded org").toBeGreaterThan(0);

  await request.storageState({ path: STORAGE_PATH });
});
