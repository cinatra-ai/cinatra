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
import { Client } from "pg";
import { DECLARED_ORG_FK_CASCADES } from "@/lib/org-write/write-registry";

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
});
