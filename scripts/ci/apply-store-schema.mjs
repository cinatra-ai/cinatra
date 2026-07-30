#!/usr/bin/env node
/**
 * Apply the canonical cinatra store bootstrap DDL (`buildCreateStoreSchemaQueries`,
 * src/lib/drizzle-store.ts) to the schema named by SUPABASE_SCHEMA in the
 * database named by SUPABASE_DB_URL.
 *
 * WHY (cinatra#2226). A CI job that runs a DB-backed suite WITHOUT booting the
 * app has no other way to get the store baseline. Two adjacent mechanisms both
 * decline the job:
 *   - the app's own boot-time `ensurePostgresSchema` only runs when the Next.js
 *     server (or a worker importing it) boots — a bare `vitest run` never does;
 *   - `scripts/schema-bootstrap.mts` deliberately SKIPS a FRESH schema (no
 *     `<schema>.metadata`), because on the prod upgrade path pre-creating tables
 *     would flip a fresh install into "existing" and execute the historical
 *     migration chain against it. A fresh CI Postgres is exactly that skipped
 *     case.
 * This entry is the third caller: FRESH-schema provisioning for a test job.
 * It is the sibling of `scripts/apply-public-schema.mjs` (Better Auth `public`
 * tables) and MUST run after it — the store DDL carries FKs to `public."user"`
 * / `"organization"` / `"team"` / `"member"`.
 *
 * The DDL is idempotent (CREATE … IF NOT EXISTS / guarded DO blocks), so
 * re-running is safe. Unlike `scripts/check-fresh-schema-ddl.mjs` (which
 * applies the same sequence inside a transaction it ALWAYS rolls back, as a
 * statement-ordering guard) this script COMMITS — provisioning is the point.
 *
 * Fail-closed: any failing statement exits 1 with the offending index + SQL
 * head + PG error, so a CI job can never proceed against a half-built schema
 * and report a vacuous green.
 *
 * RUN (needs tsx — the canonical builder is TypeScript and imports `@/…`):
 *   SUPABASE_DB_URL=postgres://… SUPABASE_SCHEMA=cinatra \
 *     node --import tsx scripts/ci/apply-store-schema.mjs
 *
 * Env:
 *   SUPABASE_DB_URL  (required) target database
 *   SUPABASE_SCHEMA  app schema (default `cinatra`)
 */
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "../../src/lib/drizzle-store.ts";

const connectionString = process.env.SUPABASE_DB_URL;
const schemaName = process.env.SUPABASE_SCHEMA || "cinatra";

if (!connectionString) {
  console.error("apply-store-schema: SUPABASE_DB_URL is required.");
  process.exit(2);
}

// Double-quote + escape, the way the migration runner quotes identifiers.
const quotedSchema = `"${schemaName.replaceAll('"', '""')}"`;

const client = new Client({ connectionString });
await client.connect();

let applied = 0;
let total = 0;
let failure = null;
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
  const queries = buildCreateStoreSchemaQueries(schemaName);
  total = queries.length;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      await client.query(q.text, q.values);
      applied++;
    } catch (err) {
      failure = {
        index: i,
        sqlHead: String(q.text).replace(/\s+/g, " ").trim().slice(0, 240),
        error: err?.message ?? String(err),
      };
      break;
    }
  }
} finally {
  await client.end();
}

if (failure) {
  console.error(
    `apply-store-schema: statement ${failure.index} of ${total} failed against ${quotedSchema}\n` +
      `  sql: ${failure.sqlHead}\n` +
      `  pg:  ${failure.error}`,
  );
  process.exit(1);
}

console.log(
  `apply-store-schema: applied ${applied}/${total} statements to ${quotedSchema}`,
);
