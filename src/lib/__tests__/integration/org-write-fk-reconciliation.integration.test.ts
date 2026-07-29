/**
 * cinatra#1938 — CI-tier FK reconciliation: the registry's declared org FK
 * catalog must match the LIVE pg_constraint truth (app-schema FKs exist only
 * as executable DDL strings, so a live catalog read is the only complete
 * check; the static DDL pins live in write-registry-1938.test.ts).
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS=1 with a real SUPABASE_DB_URL
 * (the extension-lifecycle-db-tests CI job); self-skips otherwise.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DECLARED_ORG_FK_CASCADES } from "@/lib/org-write/write-registry";

/** The live pg_constraint sweep for FKs referencing public.organization from a
 *  non-public schema (the reconciliation source of truth). */
const ORG_FK_SWEEP = `
  SELECT
    src_ns.nspname AS src_schema,
    src.relname AS src_table,
    att.attname AS src_column
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND tgt.relname = 'organization'
    AND tgt_ns.nspname = 'public'
    AND src_ns.nspname <> 'public'
`;

const dbUrl = process.env.SUPABASE_DB_URL ?? "";
const enabled =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  dbUrl !== "" &&
  !dbUrl.includes("unused:unused");

describe.skipIf(!enabled)("org FK catalog reconciliation (#1938, live)", () => {
  it("every FK referencing public.organization is declared, and vice versa", async () => {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const res = await client.query(`
        SELECT
          src_ns.nspname AS src_schema,
          src.relname AS src_table,
          att.attname AS src_column,
          c.confdeltype AS on_delete
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
        JOIN pg_class tgt ON tgt.oid = c.confrelid
        JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
        JOIN unnest(c.conkey) AS ck(attnum) ON true
        JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = ck.attnum
        WHERE c.contype = 'f'
          AND tgt.relname = 'organization'
          AND tgt_ns.nspname = 'public'
      `);
      // Better-auth's own furniture (member/invitation/team + session FK if
      // present) lives in public; the registry declares the APP-schema set.
      const appSchemaFks = res.rows
        .filter((r) => r.src_schema !== "public")
        .map((r) => `${r.src_table}.${r.src_column}`)
        .sort();
      expect(appSchemaFks).toEqual([...DECLARED_ORG_FK_CASCADES].sort());
      for (const row of res.rows.filter((r) => r.src_schema !== "public")) {
        expect(row.on_delete).toBe("c"); // all declared cascades really cascade
      }
    } finally {
      await client.end();
    }
  });

  it("catches a PLANTED orphan: an undeclared org-axis FK is flagged by the live sweep (#1939 R-acc)", async () => {
    // The delete-blocker audit's teeth: a NEW org-axis reference that is NOT in
    // the declared catalog must be caught by the live pg_constraint sweep so it
    // can never be silently orphaned by the org-delete transaction.
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const schema = `cinatra_orphan_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      // Plant a table whose org_id references public.organization but is NOT in
      // DECLARED_ORG_FK_CASCADES.
      await client.query(`
        CREATE TABLE "${schema}"."planted_orphan" (
          id text PRIMARY KEY,
          org_id text REFERENCES public."organization"(id) ON DELETE CASCADE
        )
      `);
      const res = await client.query<{ src_schema: string; src_table: string; src_column: string }>(
        ORG_FK_SWEEP,
      );
      const found = res.rows.find(
        (r) => r.src_schema === schema && r.src_table === "planted_orphan",
      );
      // The sweep MUST surface it — and it is NOT a declared cascade, so the
      // reconciliation equality assertion above would fail loud with it present.
      expect(found).toBeDefined();
      expect(found?.src_column).toBe("org_id");
      const declaredTables = new Set(
        DECLARED_ORG_FK_CASCADES.map((ref) => ref.split(".")[0]),
      );
      expect(declaredTables.has("planted_orphan")).toBe(false);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
