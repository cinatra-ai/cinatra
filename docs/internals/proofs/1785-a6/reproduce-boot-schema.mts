// Item-4 phase 1: build the REAL store schema into the lane boot DB and
// introspect the two tables the clean-boot proof seeds (installed_extension =
// the canonical store the boot gate reads; objects = the library-served rows).
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "../../../../src/lib/drizzle-store.ts";

const SCHEMA = "cinatra";
const CS = "postgres://postgres:postgres@127.0.0.1:5634/prove_1785_boot";

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

for (const t of ["installed_extension", "extension_dependency_edge", "objects"]) {
  const r = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
    [SCHEMA, t],
  );
  if (r.rows.length === 0) { console.log(`\n### ${t}: (MISSING)`); continue; }
  console.log(`\n### ${t}: ` + r.rows
    .map((x) => `${x.column_name}:${x.data_type}${x.is_nullable === "NO" ? "!" : ""}${x.column_default ? "=def" : ""}`)
    .join(", "));
}
await c.end();
