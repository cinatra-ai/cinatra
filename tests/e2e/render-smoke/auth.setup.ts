/**
 * Auth setup for the all-routes render-smoke suite.
 *
 * Adapts the RBAC `auth.setup.ts` storage-state pattern, but promotes the smoke
 * user to PLATFORM ADMIN so that admin-gated routes actually render instead of
 * redirecting to /not-authorized (requireAdminSession) or /sign-in. Platform
 * admin = the Better-Auth `public."user".role` string CONTAINS "admin" once
 * comma-split (see src/lib/auth-session.ts isPlatformAdmin / requireAdminSession).
 *
 * Steps:
 *   1. Sign up the deterministic smoke user (idempotent — 400/422 if it exists).
 *   2. Promote the user to platform admin via pg BEFORE sign-in: append "admin"
 *      to public."user".role if not already present. The session token is
 *      minted at sign-in time and the better-auth session cache makes a
 *      post-sign-in role grant INVISIBLE to the saved session — so the
 *      promotion MUST precede the sign-in that gets persisted, or admin-gated
 *      routes redirect to /not-authorized under the saved (stale, non-admin)
 *      state.
 *   3. Ensure the user has an organization membership (so set-active + the
 *      authenticated app shell work).
 *   4. Sign in to mint a session cookie that CARRIES the admin role.
 *   5. Set the active org so the authenticated app shell renders.
 *   6. Persist the cookie state to .auth/admin-state.json for the chromium project.
 *
 * Better Auth's CSRF check requires an Origin header; Playwright's `request`
 * fixture sets it from `baseURL`, so these calls succeed where a bare curl
 * (mismatched origin) would 403.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Client } from "pg";
import { test as setup, expect } from "@playwright/test";

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
const EMAIL = process.env.E2E_RENDER_SMOKE_USER_EMAIL ?? "render-smoke-admin@local.test";
const PASSWORD = process.env.E2E_RENDER_SMOKE_USER_PASSWORD ?? "RenderSmokeAdmin!2026";
const STORAGE_PATH = "tests/e2e/render-smoke/.auth/admin-state.json";
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
 * Promote the user to platform admin. Better Auth's admin plugin stores roles
 * as a comma-separated string; isPlatformAdmin / requireAdminSession comma-split
 * and check membership of "admin". Append "admin" if not already present rather
 * than clobbering any existing roles.
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
  const orgId = `render-smoke-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "Render Smoke Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`render-smoke-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

setup("create platform-admin smoke user + save session", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // 1. Ensure the user exists (idempotent — 400/422 when already present).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Render Smoke Admin" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // 2. Promote to platform admin + ensure an org membership exists — BEFORE
  //    the sign-in whose session we persist. The better-auth session cache
  //    means a role grant applied AFTER sign-in is invisible to the saved
  //    session, so admin-gated routes would redirect to /not-authorized under
  //    the stale state. Promoting first guarantees the persisted token carries
  //    the admin role.
  const c = newClient();
  await c.connect();
  let orgId: string;
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`smoke user not found: ${EMAIL}`);
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

  // 4. Set the active org so the authenticated app shell renders.
  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: orgId },
    headers,
    failOnStatusCode: false,
  });

  // 5. Persist the cookie state for the chromium render-smoke project.
  mkdirSync(dirname(STORAGE_PATH), { recursive: true });
  await request.storageState({ path: STORAGE_PATH });
});
