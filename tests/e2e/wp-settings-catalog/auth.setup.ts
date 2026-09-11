/**
 * Auth + fixture setup for the WordPress settings-catalog UAT.
 *
 * Follows the render-smoke suite's platform-admin storage-state pattern: the
 * connector settings surface is admin-gated, and a role grant applied AFTER
 * sign-in is invisible to the saved session (better-auth caches the role into
 * the session token), so the promotion MUST precede the sign-in whose cookies
 * we persist.
 *
 * Steps:
 *   1. Sign up the deterministic UAT user (idempotent — 400/422 if present).
 *   2. Promote to platform admin + ensure an org membership, via pg.
 *   3. Sign in (the persisted token now carries the admin role).
 *   4. Set the active org so the authenticated app shell renders.
 *   5. Seed the WordPress fixture matrix.
 *   6. Persist the cookie state for the chromium project.
 *
 * Better Auth's CSRF check needs an Origin header; Playwright's `request`
 * fixture sets it from `baseURL`.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { test as setup, expect } from "@playwright/test";

import {
  newClient,
  seedFixtures,
  FIXTURE_INSTANCES,
  UAT_EMAIL,
  UAT_PASSWORD,
} from "./fixtures";

import { openRegistrationForFixtures } from "../open-registration";

// Shared with the fixture module — the seeding needs the same identity to
// resolve the owning org it binds every instance to.
const EMAIL = UAT_EMAIL;
const PASSWORD = UAT_PASSWORD;
const STORAGE_PATH = "tests/e2e/wp-settings-catalog/.auth/admin-state.json";

async function userIdByEmail(c: Client, email: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
    [email],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0]!.id : null;
}

/** Better Auth stores roles as a comma-separated string; isPlatformAdmin
 * comma-splits and checks for "admin". Append rather than clobber. */
async function promoteToPlatformAdmin(c: Client, userId: string): Promise<void> {
  await c.query(
    `UPDATE public."user"
        SET role = CASE
          WHEN role IS NULL OR btrim(role) = '' THEN 'admin'
          WHEN ('admin' = ANY (string_to_array(role, ','))
            OR 'admin' = ANY (regexp_split_to_array(role, '\\s*,\\s*'))) THEN role
          ELSE role || ',admin'
        END
      WHERE id = $1`,
    [userId],
  );
}

async function ensureMemberOrg(c: Client, userId: string): Promise<string> {
  const existing = await c.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
    [userId],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0]!.organizationId;
  const orgId = `wp-settings-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "WP Settings UAT Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`wp-settings-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

setup("create platform-admin user, seed WordPress fixtures, save session", async ({
  request,
  baseURL,
}) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // Record WHICH surface this run certified. A green result means nothing
  // unless the reader knows whether it ran against the production-equivalent
  // standalone build or the `pnpm dev` fallback, so put it in the report rather
  // than leaving it to the invoker's memory.
  const external = process.env.E2E_REUSE_SERVER === "1";
  setup.info().annotations.push({
    type: "surface",
    description: external
      ? `external server at ${origin} (production-equivalent standalone build when started that way)`
      : `Playwright-managed 'pnpm dev' server at ${origin} — NOT production-equivalent`,
  });

  // Registration is closed on a fresh instance and only the first account gets
  // in on the bootstrap exception, so this harness says out loud that it needs
  // the public sign-up road open before it uses it.
  await openRegistrationForFixtures();

  // Idempotent: 200 on a fresh database, 400/422 when the UAT user is already
  // provisioned. A 403 is NOT tolerated here — Better Auth returns
  // `403 INVALID_ORIGIN` when the server's trusted-origin list does not contain
  // the origin this suite is driving, and swallowing it would turn a plain
  // misconfiguration (running the app on a port the auth config does not trust)
  // into a confusing downstream "card not found" failure. Point E2E_BASE_URL /
  // E2E_PORT at an origin the server actually trusts.
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "WP Settings Admin" },
    headers,
    failOnStatusCode: false,
  });
  expect(
    [200, 400, 422],
    `sign-up returned ${signUp.status()}: ${await signUp.text()}`,
  ).toContain(signUp.status());

  const c = newClient();
  await c.connect();
  let orgId: string;
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`UAT user not found after sign-up: ${EMAIL}`);
    await promoteToPlatformAdmin(c, userId);
    orgId = await ensureMemberOrg(c, userId);

    // Seed AFTER the app has booted (the server bootstraps the additive DDL for
    // connector_instance_server / connector_instance_tool_policy on first
    // query, and the webServer/readiness gate has already run by now).
    await seedFixtures(c);

    // Fail LOUD if the seed did not land — a silent empty matrix would make
    // every downstream assertion fail with a confusing "card not found".
    const seeded = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${(process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""')}"."connector_instance_tool_policy" WHERE connector_key = 'wordpress'`,
    );
    expect(Number(seeded.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(FIXTURE_INSTANCES.length);
  } finally {
    await c.end();
  }

  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers,
  });
  expect(signIn.ok()).toBeTruthy();

  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: orgId },
    headers,
    failOnStatusCode: false,
  });

  mkdirSync(dirname(STORAGE_PATH), { recursive: true });
  await request.storageState({ path: STORAGE_PATH });
});
