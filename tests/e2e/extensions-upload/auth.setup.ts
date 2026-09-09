/**
 * Auth setup for the `extensions-upload` e2e suite (cinatra#3204 criterion 34).
 *
 * Mints a PLATFORM-ADMIN user with an active organization and persists the
 * session, so the admin-gated `/configuration/extensions/upload` route renders and the
 * post-#805 install-target picker context (which reads the active org from the
 * session) resolves.
 *
 * Adapted verbatim from `tests/e2e/render-smoke/auth.setup.ts` — same
 * "promote-to-admin BEFORE the sign-in we persist" ordering (a role grant
 * applied after sign-in is invisible to the cached session), same direct-pg
 * seeding, same `.env.local` DB resolution.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Client } from "pg";
import { test as setup, expect } from "@playwright/test";

import { openRegistrationForFixtures } from "../open-registration";

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();
const EMAIL = process.env.E2E_UPLOAD_USER_EMAIL ?? "extensions-upload-uat@local.test";
const PASSWORD = process.env.E2E_UPLOAD_USER_PASSWORD ?? "ExtensionsUploadUAT!2026";
const STORAGE_PATH = "tests/e2e/extensions-upload/.auth/admin-state.json";
/**
 * A SECOND session, in the organization that actually holds a usable GitHub
 * connection (cinatra#3204 criteria 9, 10).
 *
 * The GitHub tab reads its precondition per the organization the screen runs
 * in, so one session can no longer show both halves of the road: the walk's own
 * organization has no connection of its own and therefore states the
 * precondition (CELL3), while a repository can only be resolved by an admin
 * whose active organization holds the connection (CELL2). Two organizations,
 * two sessions, so both cells are measurable on one instance.
 *
 * When the instance holds no GitHub connection at all this is the SAME state as
 * above: CELL2 then states, in its own skip line, the precondition it met — it
 * never silently measures the wrong organization.
 */
const GITHUB_STORAGE_PATH = "tests/e2e/extensions-upload/.auth/github-admin-state.json";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

async function userIdByEmail(c: Client, email: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [email]);
  return r.rowCount && r.rowCount > 0 ? r.rows[0]!.id : null;
}

/**
 * Promote the user to platform admin. Better Auth stores roles as a
 * comma-separated string; isPlatformAdmin / requireAdminSession comma-split and
 * check membership of "admin". Append "admin" rather than clobbering.
 */
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
  const orgId = `upload-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "Extensions Upload E2E Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`upload-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

/** The schema the app's own tables live in (the connection rows are not in `public`). */
function appSchema(): string {
  const raw = process.env.SUPABASE_SCHEMA?.trim() || ENV_LOCAL.SUPABASE_SCHEMA?.trim() || "cinatra";
  return `"${raw.replaceAll('"', '""')}"`;
}

/**
 * The organization that owns a GitHub connection identity row — the one an
 * admin can actually resolve a repository in. Read from the rows themselves so
 * the walk follows whatever the instance holds rather than a hard-coded id, and
 * a soft-deleted row is skipped exactly as the precondition's own reader skips
 * it — so the session the walk switches into is a session the screen calls
 * ready.
 */
async function organizationWithGitHubConnection(c: Client): Promise<string | null> {
  try {
    const r = await c.query<{ organization_id: string }>(
      `SELECT n.organization_id
         FROM ${appSchema()}.nango_connection n
         JOIN public."organization" o ON o.id = n.organization_id
        WHERE n.connector_key = 'github' AND n.organization_id IS NOT NULL
          AND n.deleted_at IS NULL
        LIMIT 1`,
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0]!.organization_id : null;
  } catch {
    // No connection table on this instance yet — the same answer as no row.
    return null;
  }
}

/** Membership is what `set-active` requires before it will switch the session. */
async function ensureMembership(c: Client, userId: string, orgId: string): Promise<void> {
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
     SELECT $1, $2, $3, 'member', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM public."member" WHERE "userId" = $2 AND "organizationId" = $3
      )`,
    [`upload-member-github-${orgId}`, userId, orgId],
  );
}

setup("create platform-admin user + save session", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // Registration is closed on a fresh instance and only the first account gets
  // in on the bootstrap exception, so this harness says out loud that it needs
  // the public sign-up road open before it uses it.
  await openRegistrationForFixtures({ databaseUrl: DATABASE_URL });

  // 1. Ensure the user exists (idempotent — 400/422 when already present).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Extensions Upload Admin" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // 2. Promote to platform admin + ensure an org membership BEFORE the sign-in
  //    whose session we persist (a post-sign-in grant is invisible to the cached
  //    session, so admin-gated routes would 302 to /not-authorized).
  const c = newClient();
  await c.connect();
  let orgId: string;
  let adminUserId: string;
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`extensions-upload user not found: ${EMAIL}`);
    adminUserId = userId;
    await promoteToPlatformAdmin(c, userId);
    orgId = await ensureMemberOrg(c, userId);
  } finally {
    await c.end();
  }

  // 3. Sign in to mint a session cookie that CARRIES the admin role.
  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers,
  });
  expect(signIn.ok()).toBeTruthy();

  // 4. Set the active org (the marketplace install-target picker reads it).
  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: orgId },
    headers,
    failOnStatusCode: false,
  });

  // 5. Persist the cookie state for the chromium project.
  mkdirSync(dirname(STORAGE_PATH), { recursive: true });
  await request.storageState({ path: STORAGE_PATH });

  // 6. The SECOND session: the same admin, made a member of the organization
  //    that holds a GitHub connection, with that organization active. The state
  //    file is always written — when there is no such organization it is a copy
  //    of the state above, so the GitHub cell loads a session either way and
  //    states the precondition it met instead of failing to start.
  const c2 = newClient();
  await c2.connect();
  let githubOrgId: string | null = null;
  try {
    githubOrgId = await organizationWithGitHubConnection(c2);
    if (githubOrgId) await ensureMembership(c2, adminUserId, githubOrgId);
  } finally {
    await c2.end();
  }

  if (githubOrgId) {
    const secondSignIn = await request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      headers,
    });
    expect(secondSignIn.ok()).toBeTruthy();
    const setActive = await request.post("/api/auth/organization/set-active", {
      data: { organizationId: githubOrgId },
      headers,
      failOnStatusCode: false,
    });
    expect(setActive.ok()).toBeTruthy();
    await request.storageState({ path: GITHUB_STORAGE_PATH });
  } else {
    copyFileSync(STORAGE_PATH, GITHUB_STORAGE_PATH);
  }
});
