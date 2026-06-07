/**
 * agent_templates ownership-tier schema migration tests.
 *
 * The describe block is guarded by `describe.skipIf(!process.env.SUPABASE_DB_URL)`
 * so CI without a Postgres reachable URL emits zero failures and zero noise.
 *
 * Pattern: build the full DDL chain via `buildCreateStoreSchemaQueries(name)`,
 * run it against a fresh per-test schema, then introspect via
 * `information_schema.columns` and `pg_indexes` to assert the new columns
 * + index landed. Mirrors `src/lib/__tests__/integration/_fixture.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const TEST_SCHEMA = "cinatra_test_agent_templates_schema";
let pool: Pool;

// vitest.config.ts always sets SUPABASE_DB_URL — to the placeholder
// `postgres://unused:unused@localhost:5432/unused` when the host shell did NOT
// export a real value. Skip when we see that placeholder so CI without a live
// Postgres emits zero noise.
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

describe.skipIf(!HAS_REAL_DB)("agent_templates ownership schema", () => {
  beforeAll(async () => {
    if (!HAS_REAL_DB) return;
    pool = new Pool({ connectionString: DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);

    // Run only DDL (CREATE/ALTER/DROP) — skip seed INSERT/UPDATE statements
    // that can collide with an empty test schema. Mirrors the fixture pattern
    // in src/lib/__tests__/integration/_fixture.ts.
    const queries = buildCreateStoreSchemaQueries(TEST_SCHEMA);
    for (const q of queries) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
        continue;
      }
      try {
        await pool.query(q.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tolerate dependency-missing errors against an empty schema; rethrow real failures.
        if (!msg.includes("does not exist")) throw err;
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      await pool.end();
    }
  });

  it("owner_level + owner_id columns exist as nullable text", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'agent_templates'
          AND column_name = ANY($2)`,
      [TEST_SCHEMA, ["owner_level", "owner_id"]],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.owner_level).toEqual({
      column_name: "owner_level",
      data_type: "text",
      is_nullable: "YES",
    });
    expect(byName.owner_id).toEqual({
      column_name: "owner_id",
      data_type: "text",
      is_nullable: "YES",
    });
  });

  it("agent_templates_owner_idx exists", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'agent_templates' AND indexname = 'agent_templates_owner_idx'`,
      [TEST_SCHEMA],
    );
    expect(rows.length).toBe(1);
  });

  it("backfill statement is idempotent and assigns owner_level='organization', owner_id=org_id", async () => {
    // Insert a legacy row with owner_level NULL but org_id set. The EXACT SQL
    // below is the string the migration runs; re-running it must be a safe no-op
    // for already-backfilled rows AND must correctly assign owner_level/owner_id
    // for nulls.
    await pool.query(
      `INSERT INTO "${TEST_SCHEMA}".agent_templates
         (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
       VALUES ($1, $2, 'ownership-backfill', '', '[]', '{}', '{"steps":[]}', '@cinatra/ownership-backfill-test')`,
      ["tmpl-ownership-backfill", "org-existing-ownership"],
    );
    const SQL = `UPDATE "${TEST_SCHEMA}".agent_templates
                    SET owner_level = 'organization', owner_id = org_id
                  WHERE owner_level IS NULL AND org_id IS NOT NULL`;
    await pool.query(SQL);
    // Re-run — must be a no-op (idempotency check).
    await pool.query(SQL);
    const { rows } = await pool.query(
      `SELECT owner_level, owner_id FROM "${TEST_SCHEMA}".agent_templates WHERE id = $1`,
      ["tmpl-ownership-backfill"],
    );
    expect(rows[0]).toEqual({ owner_level: "organization", owner_id: "org-existing-ownership" });
  });
});
