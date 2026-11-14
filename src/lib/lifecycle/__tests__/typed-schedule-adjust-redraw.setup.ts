/**
 * THE FLOOR THE TYPED-ADJUST TIER STANDS ON (cinatra#2853, the second fix leg).
 *
 * The bound-card road's module graph opens its pool and reads the Better Auth
 * tables at IMPORT time — before any `beforeAll` hook runs — so a scratch schema
 * that gains its tables inside the hook is already too late. This is a vitest
 * `globalSetup`, which runs before the test module is loaded at all: it creates
 * the minimal `public` floor the store's cross-schema references point at, then
 * replays the store DDL and the grant ledger's own bootstrap into the throwaway
 * schema. `teardown` drops it again.
 *
 * Mirrors the shape and the reasoning of the sibling widget tier's setup; the
 * floor is deliberately minimal and cannot stand in for the real auth schema.
 */
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { lentActionGrantSchemaQueries } from "@/lib/lent-action-grant-schema";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";

/**
 * THE THROWAWAY SCHEMA, AS A CONSTANT — never read from the environment, for
 * the reason the sibling tier's setup states: a global setup runs in the MAIN
 * process, where the config's `test.env` has not been applied, so a job that
 * exports its own `SUPABASE_SCHEMA` would hand this file the JOB's schema and
 * the `DROP SCHEMA` below would take the running harness's data with it.
 */
export const X2853_SCHEMA = "cinatra_x2853";
const TEST_SCHEMA = X2853_SCHEMA;
const q = (s: string) => s.replaceAll('"', '""');

export const X2853_PUBLIC_FLOOR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text, name text NOT NULL, email text NOT NULL, "emailVerified" boolean NOT NULL, role text)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, "createdAt" timestamptz NOT NULL, "archivedAt" timestamptz, "archiveEpoch" int)`,
  `CREATE TABLE IF NOT EXISTS public."team" (id text PRIMARY KEY, "organizationId" text, name text)`,
  `CREATE TABLE IF NOT EXISTS public."teamMember" (id text PRIMARY KEY, "teamId" text, "userId" text)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
  `CREATE TABLE IF NOT EXISTS public."oauthClient" (id text PRIMARY KEY, "clientId" text)`,
  `CREATE TABLE IF NOT EXISTS public."session" (id text PRIMARY KEY, "userId" text, token text, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz, "updatedAt" timestamptz, "activeOrganizationId" text)`,
];

export async function setup(): Promise<void> {
  if (!DB_URL) return;
  const workerSchema = process.env.SUPABASE_SCHEMA;
  if (workerSchema && workerSchema !== TEST_SCHEMA) {
    console.warn(
      `[x2853] ignoring the ambient SUPABASE_SCHEMA and using ${TEST_SCHEMA} — a global setup runs before test.env applies`,
    );
  }
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    for (const stmt of X2853_PUBLIC_FLOOR) await admin.query(stmt);
    for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      await admin.query(stmt.text);
    }
    // The grant ledger's OWN bootstrap text — the road under test mints and
    // spends a real row through it, so the table has to be the shipped one.
    for (const stmt of lentActionGrantSchemaQueries(TEST_SCHEMA)) {
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
