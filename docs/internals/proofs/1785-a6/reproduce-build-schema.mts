// Phase 1: build the REAL store schema into the proof DB, then introspect the
// columns of every table core__0059 touches so the fixture seed is faithful.
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "../../../../src/lib/drizzle-store.ts";
import {
  ARTIFACT_ID_REFERENCING_TABLES,
  OBJECT_ID_REFERENCING_TABLES,
  TRIGGER_GUARDED_DELETES,
} from "../../../../migrations/core/core__0059_purge-default-artifact-floor.mjs";

const SCHEMA = "cinatra";
const CS = "postgres://postgres:postgres@127.0.0.1:5634/prove_1785_purge";

const c = new Client({ connectionString: CS });
await c.connect();

// Minimal Better Auth stubs the store FKs reference (public.user / organization).
await c.query(`CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY)`);
await c.query(`CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY)`);
await c.query(`INSERT INTO public."user"(id) VALUES ('u1') ON CONFLICT DO NOTHING`);
await c.query(`INSERT INTO public."organization"(id) VALUES ('org1') ON CONFLICT DO NOTHING`);

const queries = buildCreateStoreSchemaQueries(SCHEMA);
let ok = 0;
const failures: string[] = [];
for (const q of queries) {
  try {
    await c.query(q.text, (q as { values?: unknown[] }).values);
    ok += 1;
  } catch (e) {
    failures.push(`${(e as Error).message}\n   -- stmt: ${q.text.slice(0, 140).replace(/\s+/g, " ")}`);
  }
}
console.log(`SCHEMA BUILD: ${ok}/${queries.length} statements applied; ${failures.length} failed`);
for (const f of failures) console.log("  FAIL:", f);

const touched = [
  "objects",
  ...ARTIFACT_ID_REFERENCING_TABLES,
  ...OBJECT_ID_REFERENCING_TABLES,
  ...TRIGGER_GUARDED_DELETES.map((t: { table: string }) => t.table),
  "artifact_uninstall_operations",
  "object_change_event",
  "change_set",
  "remote_effect_attempts",
];

for (const t of touched) {
  const r = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
    [SCHEMA, t],
  );
  if (r.rows.length === 0) {
    console.log(`\n### ${t}: (MISSING)`);
    continue;
  }
  const cols = r.rows
    .map((x) => `${x.column_name}:${x.data_type}${x.is_nullable === "NO" ? "!" : ""}${x.column_default ? "=def" : ""}`)
    .join(", ");
  console.log(`\n### ${t}: ${cols}`);
}

// Confirm the three append-only triggers exist on the real schema.
const trg = await c.query(
  `SELECT tgname, c.relname FROM pg_trigger tg
     JOIN pg_class c ON c.oid=tg.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND tg.tgname LIKE '%append_only%' ORDER BY 1`,
  [SCHEMA],
);
console.log("\n### append-only triggers present:", trg.rows.map((x) => `${x.tgname}(${x.relname})`).join(", ") || "NONE");

await c.end();
