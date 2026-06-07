/**
 * Auth + fixture setup for the RBAC browser authorization suite.
 *
 * Creates a NON-admin org member (deliberately NOT promoted to platform
 * admin) so the access-gated assertions hold:
 *   - Analytics nav hidden (member lacks metric.read).
 *   - /configuration/access-control denied (requireAdminSession).
 * The member OWNS a seeded project (so they are project admin/owner for the
 * customer-grant flow + can read the permissions surface).
 *
 * Also creates a customer user (the invitee for the grant flow) and writes
 * the seeded ids to `.auth/seed.json` for the spec.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
const EMAIL = process.env.E2E_RBAC_USER_EMAIL ?? "rbac-member-uat@local.test";
const PASSWORD = process.env.E2E_RBAC_USER_PASSWORD ?? "RbacMemberUAT!2026";
const CUSTOMER_EMAIL = process.env.E2E_RBAC_CUSTOMER_EMAIL ?? "rbac-customer-uat@local.test";
const CUSTOMER_PASSWORD = process.env.E2E_RBAC_CUSTOMER_PASSWORD ?? "RbacCustomerUAT!2026";
const STORAGE_PATH = "tests/e2e/rbac/.auth/state.json";
const SEED_PATH = "tests/e2e/rbac/.auth/seed.json";
const PROJECT_ID = "rbac-uat-project";
const PROJECT_SLUG = "rbac-uat-project";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

async function userIdByEmail(c: Client, email: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [email]);
  return r.rowCount && r.rowCount > 0 ? r.rows[0]!.id : null;
}

async function ensureMemberOrg(c: Client, userId: string): Promise<string> {
  const existing = await c.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
    [userId],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0]!.organizationId;
  const orgId = `rbac-uat-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "RBAC UAT Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`rbac-uat-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

async function ensureUserInOrg(c: Client, userId: string, orgId: string): Promise<void> {
  // project_access requires the principal user to be a member of the project's
  // org — add the customer to the member's org so EXT-01's grant insert
  // satisfies that constraint.
  const exists = await c.query(
    `SELECT 1 FROM public."member" WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
    [userId, orgId],
  );
  if (exists.rowCount && exists.rowCount > 0) return;
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
       VALUES ($1, $2, $3, 'member', now())
       ON CONFLICT (id) DO NOTHING`,
    [`rbac-uat-customer-in-member-org-${Date.now().toString(36)}`, userId, orgId],
  );
}

async function ensureProject(c: Client, ownerUserId: string, orgId: string): Promise<void> {
  // User-owned project → the owner resolves to project 'owner' (admin) via the
  // implicit-owner grant resolver, enabling the customer-grant flow + the
  // permissions surface read.
  await c.query(
    `INSERT INTO "${SCHEMA}"."projects" (id, name, description, owner_level, owner_id, organization_id, visibility, slug)
       VALUES ($1, $2, $3, 'user', $4, $5, 'private', $6)
       ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, organization_id = EXCLUDED.organization_id`,
    [PROJECT_ID, "RBAC UAT Project", "Fixture project for the RBAC e2e suite.", ownerUserId, orgId, PROJECT_SLUG],
  );
}

setup("create member + project + customer fixtures + save session", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // Order matters: better-auth sign-up auto-signs-in (returns a set-cookie),
  // so the LAST sign-in/up wins the cookie jar. Do the customer sign-up FIRST,
  // then the member sign-up + sign-in, so the saved storageState carries the
  // MEMBER session (the customer setup signs the customer in fresh in its own
  // context).
  await request.post("/api/auth/sign-up/email", {
    data: { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD, name: "RBAC Customer UAT" },
    headers,
    failOnStatusCode: false,
  });
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "RBAC Member UAT" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());
  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers,
  });
  expect(signIn.ok()).toBeTruthy();

  const c = newClient();
  await c.connect();
  let memberOrgId: string;
  let customerUserId: string;
  try {
    const memberUserId = await userIdByEmail(c, EMAIL);
    if (!memberUserId) throw new Error(`member user not found: ${EMAIL}`);
    memberOrgId = await ensureMemberOrg(c, memberUserId);
    await ensureProject(c, memberUserId, memberOrgId);
    customerUserId = (await userIdByEmail(c, CUSTOMER_EMAIL)) ?? "";
    if (!customerUserId) throw new Error(`customer user not found: ${CUSTOMER_EMAIL}`);
    // Customer must be a member of the project's org for project_access to succeed.
    await ensureUserInOrg(c, customerUserId, memberOrgId);
  } finally {
    await c.end();
  }

  // Set the member's active org so the app shell renders authenticated nav.
  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: memberOrgId },
    headers,
    failOnStatusCode: false,
  });

  // Persist the seeded ids for the spec.
  mkdirSync(dirname(SEED_PATH), { recursive: true });
  writeFileSync(
    SEED_PATH,
    JSON.stringify({ projectId: PROJECT_ID, customerUserId, memberOrgId }, null, 2),
  );

  await request.storageState({ path: STORAGE_PATH });
});
