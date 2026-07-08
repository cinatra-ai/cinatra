// Schema-bootstrap DDL pass for the baked runtime image (cinatra#1136, prod
// deploy surface).
//
// WHY. `cinatra setup prod` / `cinatra db migrate` run the versioned core
// migration chain (migrations/core/), which EXECUTES on existing schemas (the
// upgrade path) and may reference tables/columns that only THIS checkout's
// schema bootstrap (`buildCreateStoreSchemaQueries`, src/lib/drizzle-store.ts)
// creates — the boot path applies that DDL first (src/lib/core-migrations.ts:
// "Bootstrap DDL first … the baseline the versioned chain assumes"). The
// published CLI applies the checkout's bootstrap DDL before the chain on DEV
// checkouts (cinatra-cli#115), but a standalone runtime image ships no TS
// source and no tsx, so that pass skips there — and the prod deploy runs the
// chain BEFORE the new image ever boots, so "boot applies it" never happens
// first. This entry is the image-mode equivalent: esbuild bundles it
// self-contained (scripts/build-schema-bootstrap-bundle.mjs) and the image's
// deploy-compat CLI entry (packages/cli/bin/cinatra.mjs) runs the bundle
// before handing schema-mutating subcommands to the published CLI.
//
// Runs in plain Node via native type-stripping for local/dev invocation, and
// as the esbuild bundle (scripts/schema-bootstrap.bundle.mjs) in the image.
// Keep the syntax fully erasable (no enum / namespace / decorators).
//
// FRESH-SCHEMA GUARD. This pass exists for the UPGRADE path only: the chain
// EXECUTES on existing schemas and assumes the new baseline. On a FRESH
// schema (no `<schema>.metadata` — the exact `isFreshCoreSchema` probe the
// migration runner uses) the pass SKIPS without touching the database:
//   - setup's own bundled baseline + ledger-fake own the fresh path, and the
//     runner classifies freshness by `metadata`'s absence — pre-creating
//     tables here would flip a fresh install into "existing" and EXECUTE the
//     historical chain against it (codex round-1 finding 2);
//   - the bootstrap DDL references Better Auth tables (e.g. FKs to
//     public."user") that setup only creates LATER on a fresh database, so
//     applying it first would abort a first install (codex round-1 finding 1).
// The probe runs INSIDE the advisory lock so a concurrently booting server
// and this pass serialize on the same database-global lock the boot-side
// bootstrap takes.
//
// Env:
//   SUPABASE_DB_URL  (required) target database
//   SUPABASE_SCHEMA  app schema (default cinatra)
//
// Exit: 0 = every statement applied (or fresh-schema skip); 1 = a statement
// failed; 2 = misconfig. The DDL is idempotent (CREATE … IF NOT EXISTS).
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "../src/lib/drizzle-store.ts";

const connectionString = process.env.SUPABASE_DB_URL;
const schemaName = process.env.SUPABASE_SCHEMA || "cinatra";

if (!connectionString) {
  console.error("schema-bootstrap: SUPABASE_DB_URL is required.");
  process.exit(2);
}

// `<schema>.metadata` regclass — identifier quoted the way the migration
// runner quotes it (double-quote + escape), so the freshness probe matches
// `isFreshCoreSchema` exactly.
const quotedSchema = `"${schemaName.replaceAll('"', '""')}"`;

const client = new Client({ connectionString });
await client.connect();
let applied = 0;
let queries: ReturnType<typeof buildCreateStoreSchemaQueries> = [];
try {
  // Bounded waits: a wedged lock holder must fail the deploy loudly instead
  // of hanging it (the migration runner uses the same 120s ceiling).
  await client.query("SET lock_timeout = '120s'");
  await client.query("SET statement_timeout = '120s'");
  // Same database-global advisory lock the boot-side bootstrap takes
  // (session-scoped; released when this short-lived session ends), so a
  // concurrently booting server and this pass serialize instead of racing
  // on shared catalog objects.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["cinatra-schema-init"]);
  const fresh = await client.query("SELECT to_regclass($1) AS t", [`${quotedSchema}.metadata`]);
  if (!fresh.rows[0]?.t) {
    console.log(
      `  Schema bootstrap DDL: skipped (fresh schema ${schemaName} — setup's bundled baseline ` +
        `+ ledger-fake own a first install; boot completes the bootstrap).`,
    );
  } else {
    queries = buildCreateStoreSchemaQueries(schemaName);
    for (const q of queries) {
      try {
        await client.query(q.text, q.values as unknown[] | undefined);
        applied++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `schema-bootstrap: statement ${applied + 1}/${queries.length} failed: ` +
            `${String(q.text).slice(0, 160)}\n  ${msg}`,
        );
        process.exitCode = 1;
        break;
      }
    }
    if (process.exitCode !== 1) {
      console.log(
        `  Schema bootstrap DDL: applied ${applied}/${queries.length} statements (${schemaName}).`,
      );
    }
  }
} finally {
  await client.end();
}
