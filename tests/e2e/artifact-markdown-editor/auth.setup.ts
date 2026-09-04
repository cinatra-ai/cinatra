/**
 * Auth setup for the markdown-editor browser suite (cinatra#3026, lifecycle-c W2).
 *
 * The editor's affordance is gated on `artifact.update`, which an ORGANIZATION
 * OWNER holds — so this setup makes an owner and nothing more. No platform-admin
 * promotion: the suite exists to prove what an ordinary person with write rights
 * on their own artifact sees, and giving the test user more rights than that
 * would prove the affordance for a role no reader has.
 *
 * Adapts the render-smoke storage-state pattern beside it: sign up (idempotent),
 * ensure an organization membership, sign in, set the active organization,
 * persist the cookie state.
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
const EMAIL = process.env.E2E_MD_EDITOR_USER_EMAIL ?? "markdown-editor-owner@local.test";
const PASSWORD = process.env.E2E_MD_EDITOR_USER_PASSWORD ?? "MarkdownEditorOwner!2026";
const STORAGE_PATH = "tests/e2e/artifact-markdown-editor/.auth/owner-state.json";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

async function userIdByEmail(c: Client, email: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [
    email,
  ]);
  return r.rowCount && r.rowCount > 0 ? r.rows[0]!.id : null;
}

async function ensureOwnerOrg(c: Client, userId: string): Promise<string> {
  const existing = await c.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
    [userId],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0]!.organizationId;
  const orgId = `md-editor-org-${Date.now().toString(36)}`;
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [orgId, "Markdown Editor Org", orgId],
  );
  await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`md-editor-member-${Date.now().toString(36)}`, userId, orgId],
  );
  return orgId;
}

setup("create the owner who may edit, and save the session", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://127.0.0.1:3000";
  const headers = { Origin: origin } as const;

  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Markdown Editor Owner" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await c.connect();
  let orgId: string;
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`the editor's test user was not created: ${EMAIL}`);
    orgId = await ensureOwnerOrg(c, userId);
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
