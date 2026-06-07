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
// SAFE: creates a uniquely-named `ddlcheck_*` schema and `DROP SCHEMA …
// CASCADE`s it in a finally block. Never touches `cinatra` / `public` /
// any `cinatra_*` schema.
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

const client = new Client({ connectionString: conn });
await client.connect();

let failure = null;
let applied = 0;
let total = 0;
try {
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
} finally {
  // Always tear the throwaway schema down, even on failure.
  await client
    .query(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
    .catch(() => {});
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
    `throwaway schema "${schema}" (dropped).`,
);
