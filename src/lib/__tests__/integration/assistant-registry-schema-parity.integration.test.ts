/**
 * AC#3 (cinatra#1874 Epic #1873 W1) — a FRESH install and an operator UPGRADE
 * converge to an IDENTICAL schema for the registry-foundation artifacts, proven
 * against REAL Postgres by diffing `information_schema`.
 *
 *   FRESH   schema: the fresh-install bootstrap DDL builds the final shape
 *           directly (assistant_handles WITH origin/package_name inline; the
 *           audience + alias tables; installed_extension WITH assistant_declaration).
 *   UPGRADE schema: a pre-1874 base (assistant_handles WITHOUT origin/package_name;
 *           installed_extension WITHOUT assistant_declaration) + the core__0061
 *           migration's `buildUpSql`.
 *
 * The two schemas must present identical columns (name, type, nullability,
 * default), CHECK constraints, and indexes on the four affected tables. Self-skips
 * without a real SUPABASE_DB_URL (same contract as the sibling integration tests).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assistantHandleSchemaQueries } from "@/lib/assistant-thread-schema";
import { assistantRegistrySchemaQueries } from "@/lib/assistant-registry-schema";
import { buildUpSql } from "../../../../migrations/core/core__0061_assistant-registry-foundation.mjs";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const maybe = hasDb ? describe : describe.skip;

const AFFECTED = ["assistant_handles", "assistant_audience", "assistant_tag_alias", "installed_extension"] as const;

/** Pre-1874 base (upgrade start point): handles WITHOUT origin/package_name,
 *  installed_extension WITHOUT assistant_declaration, plus agent_templates. */
function preUpgradeBaseDdl(s: string): string[] {
  return [
    `CREATE TABLE "${s}".assistant_handles (
      assistant_user_id text PRIMARY KEY,
      handle text NOT NULL,
      is_override boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX assistant_handles_handle_key ON "${s}".assistant_handles (handle)`,
    `CREATE TABLE "${s}".agent_templates (
      id text PRIMARY KEY,
      package_name text,
      agent_kind text NOT NULL DEFAULT 'executor',
      assistant_user_id text
    )`,
    `CREATE TABLE "${s}".installed_extension (
      id text PRIMARY KEY,
      package_name text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'active'
    )`,
  ];
}

/** Fresh-install DDL for the same artifacts — the bootstrap builders + the
 *  installed_extension.assistant_declaration column exactly as drizzle-store adds
 *  it inline on a fresh DB. */
function freshInstallDdl(s: string): string[] {
  return [
    // installed_extension is born with assistant_declaration on a fresh DB.
    `CREATE TABLE "${s}".installed_extension (
      id text PRIMARY KEY,
      package_name text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'active'
    )`,
    `ALTER TABLE "${s}".installed_extension ADD COLUMN IF NOT EXISTS assistant_declaration jsonb`,
    `CREATE TABLE "${s}".agent_templates (
      id text PRIMARY KEY,
      package_name text,
      agent_kind text NOT NULL DEFAULT 'executor',
      assistant_user_id text
    )`,
    // assistant_handles (with origin/package_name) + audience + alias.
    ...assistantHandleSchemaQueries(s).map((q) => q.text),
    ...assistantRegistrySchemaQueries(s).map((q) => q.text),
  ];
}

type ColShape = { column: string; type: string; nullable: string; default: string | null };

async function columnsOf(c: Client, schema: string, table: string): Promise<ColShape[]> {
  const r = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY column_name`,
    [schema, table],
  );
  return r.rows.map((row) => ({
    column: row.column_name,
    type: row.data_type,
    nullable: row.is_nullable,
    // Normalize the schema-qualified sequence name embedded in IDENTITY defaults
    // so the two randomly-named schemas compare equal.
    default: row.column_default ? String(row.column_default).replaceAll(schema, "<schema>") : null,
  }));
}

async function checkConstraintsOf(c: Client, schema: string, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT tc.constraint_name, cc.check_clause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'CHECK'
        AND tc.constraint_name NOT LIKE '%_not_null'`,
    [schema, table],
  );
  return r.rows.map((row) => `${row.constraint_name}::${row.check_clause}`).sort();
}

async function indexesOf(c: Client, schema: string, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT indexname, replace(indexdef, $1, '<schema>') AS def
       FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    [schema, table],
  );
  return r.rows.map((row) => `${row.indexname}::${String(row.def).replaceAll(schema, "<schema>")}`).sort();
}

maybe("AC#3 — fresh-install vs upgrade schema parity (live)", () => {
  const freshSchema = `parity_fresh_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const upSchema = `parity_up_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: dbUrl });
    await c.connect();
    await c.query(`CREATE SCHEMA "${freshSchema}"`);
    await c.query(`CREATE SCHEMA "${upSchema}"`);

    for (const sql of freshInstallDdl(freshSchema)) await c.query(sql);

    for (const sql of preUpgradeBaseDdl(upSchema)) await c.query(sql);
    // The migration's up SQL, parametrized to the upgrade schema.
    for (const sql of buildUpSql(upSchema)) await c.query(sql);
  });

  afterAll(async () => {
    if (c) {
      await c.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`).catch(() => {});
      await c.query(`DROP SCHEMA IF EXISTS "${upSchema}" CASCADE`).catch(() => {});
      await c.end();
    }
  });

  it.each(AFFECTED)("table %s: columns are identical across fresh and upgrade", async (table) => {
    const fresh = await columnsOf(c, freshSchema, table);
    const up = await columnsOf(c, upSchema, table);
    expect(up).toEqual(fresh);
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("assistant_handles gains origin (NOT NULL, default standalone) + package_name identically", async () => {
    for (const schema of [freshSchema, upSchema]) {
      const cols = await columnsOf(c, schema, "assistant_handles");
      const origin = cols.find((x) => x.column === "origin");
      const pkg = cols.find((x) => x.column === "package_name");
      expect(origin, `origin missing in ${schema}`).toBeTruthy();
      expect(origin?.nullable).toBe("NO");
      expect(origin?.default).toContain("standalone");
      expect(pkg?.nullable).toBe("YES");
    }
  });

  it("installed_extension gains assistant_declaration (jsonb) identically", async () => {
    for (const schema of [freshSchema, upSchema]) {
      const cols = await columnsOf(c, schema, "installed_extension");
      const decl = cols.find((x) => x.column === "assistant_declaration");
      expect(decl?.type).toBe("jsonb");
      expect(decl?.nullable).toBe("YES");
    }
  });

  it.each(AFFECTED)("table %s: CHECK constraints + indexes are identical", async (table) => {
    expect(await checkConstraintsOf(c, upSchema, table)).toEqual(await checkConstraintsOf(c, freshSchema, table));
    expect(await indexesOf(c, upSchema, table)).toEqual(await indexesOf(c, freshSchema, table));
  });
});
