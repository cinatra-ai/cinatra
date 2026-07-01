// Live fresh-schema DDL regression guard for cold-start
// failures.
//
// WHY: `buildCreateStoreSchemaQueries()` is invisible-bug-prone — on a
// populated DB every object already exists so statement order never
// matters, but on ANY fresh Postgres schema (light worktree
// `cinatra_<slug>`, heavy clone `cinatra_clone_<slug>`, CI) a seed `INSERT`
// emitted before the `CREATE TABLE` / `ADD COLUMN` it references aborts the
// whole DDL batch and crashes the Next.js instrumentation hook at cold
// boot. A static/topological assertion would be model-based and could drift
// from real SQL semantics, so this guard applies the FULL generated
// sequence to a throwaway schema against a real Postgres and asserts every
// statement succeeds — the exact production failure mode.
//
// BETTER AUTH PRECONDITION: the store DDL cross-references the Better Auth
// `public."user"` / `"organization"` / `"team"` / `"member"` tables (FKs, slug
// backfills, dedup, indexes, and slug-move triggers). In a real boot those
// tables already exist — `cinatra setup prod` runs the Better Auth bootstrap
// migration BEFORE the store schema (see scripts/better-auth-migrate.mts and
// the "Better Auth: ran" → "Workspace store schema: ready" order proven by
// scripts/ci/upgrade-proof.sh). So this guard first CREATEs the minimal shape
// of those public tables the store DDL touches (only when absent — it never
// alters or drops a real one), matching production boot order, then applies the
// store DDL. Without this, the guard fails at the first FK to `public."user"`
// — a harness gap, not a product bug.
//
// SAFE / PERSISTS NOTHING: the whole run (precondition stubs + the store DDL,
// which itself ALTERs `public."team"` and creates public triggers/indexes) is
// wrapped in a single transaction that is ALWAYS `ROLLBACK`ed in a finally
// block, so nothing — not the `ddlcheck_*` schema, not the public stubs, not
// the store DDL's public mutations — is persisted. The guard therefore does not
// modify `cinatra` / `public` / any `cinatra_*` schema on disk even when run
// against a live dev DB; transaction rollback is the safety boundary (the SQL
// hard-references `public."user"`, so the object must be visible in-txn).
//
// RUN: `pnpm check:fresh-schema`
//   env SUPABASE_DB_URL (or DATABASE_URL) — Postgres connection string.
//   env DRIZZLE_STORE_PATH — optional override of the source under test
//     (used to point the guard at a worktree copy; defaults to the
//     repo-relative src/lib/drizzle-store.ts).
//
// EXIT: 0 = all statements applied cleanly; 1 = a statement failed (prints
// the offending index + SQL head + PG error); 2 = misconfiguration.

import { Client } from "pg";

const conn = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!conn) {
  console.error(
    "check-fresh-schema-ddl: SUPABASE_DB_URL (or DATABASE_URL) is required.",
  );
  process.exit(2);
}

const storePath =
  process.env.DRIZZLE_STORE_PATH ||
  new URL("../src/lib/drizzle-store.ts", import.meta.url).pathname;

let buildCreateStoreSchemaQueries;
try {
  ({ buildCreateStoreSchemaQueries } = await import(storePath));
} catch (e) {
  console.error(
    `check-fresh-schema-ddl: cannot import ${storePath}: ${e?.message ?? e}`,
  );
  process.exit(2);
}
if (typeof buildCreateStoreSchemaQueries !== "function") {
  console.error(
    "check-fresh-schema-ddl: buildCreateStoreSchemaQueries export not found.",
  );
  process.exit(2);
}

const schema = `ddlcheck_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 7)}`;

// Minimal shape of the Better Auth `public` tables the store DDL cross-
// references (FK targets + the columns the backfills/dedup/triggers read).
// Created only when absent so a run against a live dev DB never redefines a
// real Better Auth table; the surrounding transaction is rolled back regardless.
// `public."team"` deliberately omits `slug` — the store DDL ADDs it (matching
// the real upgrade path where slug is a store-migration addition, not a Better
// Auth column).
const BETTER_AUTH_PRECONDITION = [
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text)`,
  `CREATE TABLE IF NOT EXISTS public."team" (id text PRIMARY KEY, "organizationId" text, name text)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
];

const client = new Client({ connectionString: conn });
await client.connect();

let failure = null;
let applied = 0;
let total = 0;
let inTxn = false;
try {
  // Wrap EVERYTHING in one transaction: the precondition stubs AND the store
  // DDL (which mutates `public` via ALTER/CREATE TRIGGER/CREATE INDEX) are
  // rolled back in the finally, so the guard persists nothing to disk.
  await client.query("BEGIN");
  inTxn = true;

  for (const text of BETTER_AUTH_PRECONDITION) {
    await client.query(text);
  }

  const queries = buildCreateStoreSchemaQueries(schema);
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
} catch (err) {
  // A precondition-stub failure (or BEGIN failure) is a misconfiguration, not a
  // DDL-ordering finding — surface it distinctly.
  if (!failure) {
    console.error(
      `check-fresh-schema-ddl: setup failed before the store DDL loop: ${err?.message ?? err}`,
    );
    try {
      if (inTxn) await client.query("ROLLBACK");
    } catch {}
    await client.end();
    process.exit(2);
  }
} finally {
  // Always roll the whole transaction back — persists nothing (schema, public
  // stubs, and the store DDL's public mutations all vanish), even on failure.
  if (inTxn) {
    await client.query("ROLLBACK").catch(() => {});
  }
  await client.end();
}

if (failure) {
  console.error(
    `✗ FRESH-SCHEMA DDL FAILED — statement #${failure.index + 1} of ${total} ` +
      `(${applied} applied before failure)`,
  );
  console.error(`  PG error: ${failure.error}`);
  console.error(`  SQL head: ${failure.sqlHead}…`);
  console.error(
    "  → buildCreateStoreSchemaQueries emits a statement before a CREATE/ADD " +
      "COLUMN it depends on. Keep the structural-DDL-then-seed ordering.",
  );
  process.exit(1);
}

console.log(
  `✓ fresh-schema OK — ${applied}/${total} statements applied cleanly to ` +
    `throwaway schema "${schema}" over the Better Auth precondition ` +
    `(all rolled back — nothing persisted).`,
);
