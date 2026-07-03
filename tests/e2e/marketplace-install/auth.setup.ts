/**
 * Auth setup for the `marketplace-install` e2e suite (#836).
 *
 * Mints a PLATFORM-ADMIN user with an active organization and persists the
 * session, so the admin-gated `/configuration/marketplace` route renders and the
 * post-#805 install-target picker context (which reads the active org from the
 * session) resolves.
 *
 * Adapted verbatim from `tests/e2e/render-smoke/auth.setup.ts` — same
 * "promote-to-admin BEFORE the sign-in we persist" ordering (a role grant
 * applied after sign-in is invisible to the cached session), same direct-pg
 * seeding, same `.env.local` DB resolution.
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
const EMAIL = process.env.E2E_MP_INSTALL_USER_EMAIL ?? "marketplace-install-uat@local.test";
const PASSWORD = process.env.E2E_MP_INSTALL_USER_PASSWORD ?? "MarketplaceInstallUAT!2026";
const STORAGE_PATH = "tests/e2e/marketplace-install/.auth/admin-state.json";
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
  const orgId = `mp-install-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "Marketplace Install E2E Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`mp-install-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

setup("create platform-admin user + save session", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // 1. Ensure the user exists (idempotent — 400/422 when already present).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Marketplace Install Admin" },
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
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`marketplace-install user not found: ${EMAIL}`);
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
});
