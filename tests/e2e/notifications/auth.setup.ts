/**
 * Auth setup for the notifications flyout UAT.
 *
 * Pattern matches `tests/e2e/dashboards/auth.setup.ts`. The runtime
 * order is:
 *   1. Idempotent Better Auth sign-up.
 *   2. Sign in (mints the session cookie).
 *   3. Promote the test user to platform admin (so admin-only paths
 *      stay reachable even though the notifications surface isn't
 *      admin-gated — keeps the setup pattern consistent with the
 *      agents-run harness so the storage state can be reused).
 *   4. Ensure an active organization exists.
 *   5. Seed 12 terminal notifications + 1 running info-kind row.
 *   6. Persist the cookie state for the chromium project.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { test as setup, expect } from "@playwright/test";

import {
  seedNotificationFixtures,
  type NotificationsSeedOptions,
} from "./seed";

// Read `.env.local` if present so the harness picks up the
// worktree's clone DB URL without requiring the operator to export
// SUPABASE_DB_URL in the shell. Mirrors how `scripts/dev-server.mjs`
// loads the env. Falls back to the canonical main-repo defaults so the
// harness works against `cinatra` too.
function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();

const EMAIL = process.env.E2E_NOTIF_USER_EMAIL ?? "notif-uat@local.test";
const PASSWORD = process.env.E2E_NOTIF_USER_PASSWORD ?? "NotifUAT!2026";
const STORAGE_PATH = "tests/e2e/notifications/.auth/state.json";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA =
  process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

async function grantAdminRoleByEmail(email: string): Promise<void> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query(
      `UPDATE public."user"
         SET role = 'admin'
        WHERE email = $1 AND COALESCE(role, '') != 'admin'`,
      [email],
    );
  } finally {
    await client.end();
  }
}

// better-auth's `organization/create` endpoint goes through
// the teams plugin, which auto-creates a default team but doesn't pass
// the required `slug` column (an additionalField in `src/lib/auth.ts`).
// On a fresh test user (no pre-existing org) this hard-fails with
// `null value in column "slug" of relation "team"`. The agents-run
// harness side-steps the bug by re-using a long-lived test user whose
// org was created before the team.slug NOT NULL constraint landed.
//
// For an isolated clone DB we don't have that history, so insert the
// org + member rows directly via pg. The org is the only thing the
// notifications spec needs (no teams, no resources), so we keep it
// minimal.
async function ensureOrganizationByDirectInsert(email: string): Promise<void> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (userRes.rowCount === 0) {
      throw new Error(
        `ensureOrganizationByDirectInsert: user not found for ${email}`,
      );
    }
    const userId = userRes.rows[0]!.id;
    const existingOrg = await client.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
      [userId],
    );
    if (existingOrg.rowCount && existingOrg.rowCount > 0) {
      return; // user already has an org membership
    }
    const orgId = `notif-uat-org-${Date.now().toString(36)}`;
    const memberId = `notif-uat-member-${Date.now().toString(36)}`;
    await client.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
        VALUES ($1, $2, $3, now())
        ON CONFLICT (id) DO NOTHING`,
      [orgId, "Notif UAT Org", orgId],
    );
    await client.query(
      `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
        VALUES ($1, $2, $3, 'owner', now())
        ON CONFLICT (id) DO NOTHING`,
      [memberId, userId, orgId],
    );
  } finally {
    await client.end();
  }
}

setup(
  "create test user + seed notification fixtures + save session",
  async ({ request, baseURL }) => {
    const origin = baseURL ?? "http://localhost:3100";
    const COMMON_HEADERS = { Origin: origin } as const;

    // 1. Sign-up (idempotent).
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: { email: EMAIL, password: PASSWORD, name: "Notif UAT" },
      headers: COMMON_HEADERS,
      failOnStatusCode: false,
    });
    expect([200, 400, 422]).toContain(signUp.status());

    // 2. Promote to platform admin BEFORE sign-in so the session that
    //    mints in step 3 carries the admin role. Required for
    //    organization/create (`allowUserToCreateOrganization` gates on
    //    role membership at session-mint time; session cache means a
    //    post-sign-in role grant is invisible to that endpoint).
    await grantAdminRoleByEmail(EMAIL);

    // 3. Sign-in.
    const signIn = await request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      headers: COMMON_HEADERS,
    });
    expect(signIn.ok()).toBeTruthy();

    // 4. Ensure active organization. Direct-pg insert side-steps a
    //    better-auth team-plugin bug that fails `organization/create`
    //    on fresh users (team.slug NOT NULL not satisfied — see comment
    //    on `ensureOrganizationByDirectInsert`).
    await ensureOrganizationByDirectInsert(EMAIL);

    // 5. Seed notifications.
    const seedOpts: NotificationsSeedOptions = {
      email: EMAIL,
      databaseUrl: DATABASE_URL,
      schema: SCHEMA,
    };
    const seeded = await seedNotificationFixtures(seedOpts);
    expect(seeded.terminalCount).toBeGreaterThanOrEqual(12);
    expect(seeded.runningCount).toBe(1);

    // 6. Persist storage state.
    await request.storageState({ path: STORAGE_PATH });
  },
);
