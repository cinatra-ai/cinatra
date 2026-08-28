/**
 * THE FLOOR THIS TIER STANDS ON (cinatra#3052), built BEFORE the suite imports.
 *
 * The widget flow's module graph opens its pool and reads the Better Auth
 * tables at IMPORT time — before any `beforeAll` hook runs — so a scratch
 * database that gains its tables inside the hook is already too late. This is a
 * vitest `globalSetup`, which runs before the test module is loaded at all: it
 * creates the minimal `public` floor the store's cross-schema foreign keys and
 * the widget predicates point at, then replays the store DDL into the
 * throwaway schema. `teardown` drops it again.
 *
 * The floor is deliberately minimal and cannot stand in for the real auth
 * schema: enough columns for the references to resolve and for the seeds the
 * suite writes, in the spirit of `scripts/check-fresh-schema-ddl.mjs`'s own
 * precondition block rather than a copy of it. On a database provisioned the
 * repository's own way every statement is an `IF NOT EXISTS` no-op.
 */
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";

/**
 * THE THROWAWAY SCHEMA, AS A CONSTANT — never read from the environment.
 *
 * This module is a vitest `globalSetup`, so it runs in the MAIN process, where
 * `test.env` has NOT been applied: the config's `SUPABASE_SCHEMA` reaches the
 * WORKERS only. A CI job that exports its own `SUPABASE_SCHEMA` — the held-turn
 * harness exports `cinatra` — would therefore hand this file the JOB's schema,
 * and the `DROP SCHEMA` below would take the running harness's own data with
 * it. So the name is stated here, the config states the same name for the
 * workers, and a mismatch between them is refused rather than obeyed.
 */
export const X3052_SCHEMA = "cinatra_x3052";
const TEST_SCHEMA = X3052_SCHEMA;
const q = (s: string) => s.replaceAll('"', '""');

export const X3052_PUBLIC_FLOOR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text, name text NOT NULL, email text NOT NULL, "emailVerified" boolean NOT NULL, role text)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, "createdAt" timestamptz NOT NULL, "archivedAt" timestamptz, "archiveEpoch" int)`,
  `CREATE TABLE IF NOT EXISTS public."team" (id text PRIMARY KEY, "organizationId" text, name text)`,
  `CREATE TABLE IF NOT EXISTS public."teamMember" (id text PRIMARY KEY, "teamId" text, "userId" text)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
  `CREATE TABLE IF NOT EXISTS public."oauthClient" (id text PRIMARY KEY, "clientId" text)`,
  // THE SIGN-IN ROW's table. The widget authorisation names the session that
  // made it and every later read asks whether that session is still there.
  `CREATE TABLE IF NOT EXISTS public."session" (id text PRIMARY KEY, "userId" text, token text, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz, "updatedAt" timestamptz, "activeOrganizationId" text)`,
];

export async function setup(): Promise<void> {
  if (!DB_URL) return;
  // The workers must agree with this file about which schema is the throwaway
  // one. They read the config's `test.env`; if that ever names something else,
  // one of the two is about to act on a schema it does not own.
  const workerSchema = process.env.SUPABASE_SCHEMA;
  if (workerSchema && workerSchema !== TEST_SCHEMA) {
    // A job-level export is the ordinary case and is exactly what must NOT be
    // obeyed here — the tier owns `cinatra_x3052` and nothing else.
    console.warn(
      `[x3052] ignoring the ambient SUPABASE_SCHEMA and using ${TEST_SCHEMA} — a global setup runs before test.env applies`,
    );
  }
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    for (const stmt of X3052_PUBLIC_FLOOR) await admin.query(stmt);
    for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      await admin.query(stmt.text);
    }
  } finally {
    await admin.end();
  }
}

export async function teardown(): Promise<void> {
  if (!DB_URL) return;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  } finally {
    await admin.end();
  }
}
