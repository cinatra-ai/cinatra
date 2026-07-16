/**
 * Shared setup helpers for the unified /notifications v2 conformance UAT
 * (cinatra#1561, E11). Consumed by BOTH auth setups — the seeded main viewer
 * (`auth.setup.ts`) and the zero-row empty-state user (`auth.empty.setup.ts`).
 *
 * The heavy lifting (Better Auth sign-up + admin promotion + org provisioning)
 * is factored here so the two setups differ only in what they seed. Direct-pg
 * inserts for org/member side-step a Better Auth team-plugin bug that fails
 * `organization/create` on fresh users (team.slug NOT NULL) — the same shim the
 * retired flyout setup used.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();

export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
export const SCHEMA =
  process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

export async function userIdByEmail(email: string): Promise<string> {
  const client = newClient();
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (res.rowCount === 0) throw new Error(`user not found for ${email}`);
    return res.rows[0]!.id;
  } finally {
    await client.end();
  }
}

export async function grantAdminRoleByEmail(email: string): Promise<void> {
  const client = newClient();
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

/**
 * Ensure `email` belongs to an organization, returning the org id (an existing
 * membership's org, or a freshly direct-inserted one). Returning the id lets the
 * caller both `organization/set-active` it (so the session carries
 * `activeOrganizationId` — required for the approval sources to run) and scope
 * the approval seed to it.
 */
export async function ensureOrganizationByDirectInsert(email: string): Promise<string> {
  const client = newClient();
  await client.connect();
  try {
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (userRes.rowCount === 0) throw new Error(`ensureOrganization: user not found for ${email}`);
    const userId = userRes.rows[0]!.id;

    const existing = await client.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
      [userId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0]!.organizationId;
    }

    const orgId = `notif-uat-org-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const memberId = `notif-uat-member-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
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
    return orgId;
  } finally {
    await client.end();
  }
}
