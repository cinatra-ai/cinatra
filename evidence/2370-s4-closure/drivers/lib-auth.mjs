// Shared auth + helpers for the #2370 S4 evidence drivers.
// Runs on host2 against the production-equivalent build (next build + next start).
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

export function readEnvLocal(cwd = process.cwd()) {
  const raw = readFileSync(resolve(cwd, ".env.local"), "utf-8");
  const out = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export const ENV_LOCAL = readEnvLocal();
export const BASE = process.env.S4_BASE ?? "http://localhost:3001";
export const EMAIL = "appt-s4-uat@local.test";
export const PASSWORD = process.env.S4_PASSWORD ?? "<lane-local UAT password — redacted for the record>";
export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? ENV_LOCAL.SUPABASE_DB_URL ?? "<lane DB URL — read from SUPABASE_DB_URL in the lane .env.local>";

function newClient() {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
}

export async function withDb(fn) {
  const c = newClient();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Sign up (idempotent), promote to platform admin + org owner, sign in, set active org. */
export async function authenticate(context, steps = []) {
  const headers = { Origin: BASE };
  const signUp = await context.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email: EMAIL, password: PASSWORD, name: "Appt S4 UAT Admin" },
    headers,
    failOnStatusCode: false,
  });
  steps.push(`sign-up status=${signUp.status()}`);

  const orgId = await withDb(async (c) => {
    const u = await c.query(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [EMAIL]);
    if (!u.rowCount) throw new Error(`user not found: ${EMAIL}`);
    const userId = u.rows[0].id;
    await c.query(
      `UPDATE public."user" SET role = CASE
         WHEN role IS NULL OR btrim(role) = '' THEN 'admin'
         WHEN ('admin' = ANY (string_to_array(role, ','))) THEN role
         ELSE role || ',admin' END
       WHERE id = $1`,
      [userId],
    );
    const m = await c.query(`SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`, [userId]);
    if (m.rowCount) return m.rows[0].organizationId;
    const oid = `appt-s4-org`;
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1,$2,$3, now()) ON CONFLICT (id) DO NOTHING`,
      [oid, "Appt S4 UAT Org", oid],
    );
    await c.query(
      `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt") VALUES ($1,$2,$3,'owner', now()) ON CONFLICT (id) DO NOTHING`,
      [`appt-s4-member`, userId, oid],
    );
    return oid;
  });

  const signIn = await context.request.post(`${BASE}/api/auth/sign-in/email`, {
    data: { email: EMAIL, password: PASSWORD },
    headers,
    failOnStatusCode: false,
  });
  steps.push(`sign-in status=${signIn.status()}`);
  const setActive = await context.request.post(`${BASE}/api/auth/organization/set-active`, {
    data: { organizationId: orgId },
    headers,
    failOnStatusCode: false,
  });
  steps.push(`set-active-org status=${setActive.status()} org=${orgId}`);
  return orgId;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function shot(page, dir, name, opts = {}) {
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: opts.fullPage ?? true });
  return `${name}.png`;
}
