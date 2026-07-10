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
    // Mirrors the EXACT backfill in buildCreateStoreSchemaQueries
    // (`owner_id = COALESCE(org_id, '') WHERE owner_level IS NULL`). In the
    // real migration sequence that UPDATE runs BEFORE agent_owner_move_trg is
    // created (cinatra#550); the beforeAll here applies DDL only, so the
    // trigger already exists — disable it around the replay to reproduce the
    // migration's ordering (the trigger RAISEs on exactly the legacy
    // owner_level-NULL rows the backfill exists to repair).
    const SQL = `UPDATE "${TEST_SCHEMA}".agent_templates
                    SET owner_level = 'organization', owner_id = COALESCE(org_id, '')
                  WHERE owner_level IS NULL`;
    await pool.query(
      `ALTER TABLE "${TEST_SCHEMA}".agent_templates DISABLE TRIGGER agent_owner_move_trg`,
    );
    try {
      await pool.query(SQL);
      // Re-run — must be a no-op (idempotency check).
      await pool.query(SQL);
    } finally {
      await pool.query(
        `ALTER TABLE "${TEST_SCHEMA}".agent_templates ENABLE TRIGGER agent_owner_move_trg`,
      );
    }
    const { rows } = await pool.query(
      `SELECT owner_level, owner_id FROM "${TEST_SCHEMA}".agent_templates WHERE id = $1`,
      ["tmpl-ownership-backfill"],
    );
    expect(rows[0]).toEqual({ owner_level: "organization", owner_id: "org-existing-ownership" });
  });
});

// ---------------------------------------------------------------------------
// Interaction axis (cinatra-ai/cinatra#1037 P1) — agent_kind + assistant_config
// + the two invariant CHECK constraints, proven live against Postgres.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)("agent_templates interaction axis (#1037 P1)", () => {
  const KIND_SCHEMA = "cinatra_test_agent_kind_schema";
  let kindPool: Pool;

  beforeAll(async () => {
    if (!HAS_REAL_DB) return;
    kindPool = new Pool({ connectionString: DB_URL });
    await kindPool.query(`DROP SCHEMA IF EXISTS "${KIND_SCHEMA}" CASCADE`);
    await kindPool.query(`CREATE SCHEMA "${KIND_SCHEMA}"`);
    const queries = buildCreateStoreSchemaQueries(KIND_SCHEMA);
    for (const q of queries) {
      const trimmed = q.text.trim().toUpperCase();
      const head = trimmed.slice(0, 6);
      // Include DO blocks (via startsWith) — the interaction-axis invariant
      // CHECKs are added through the bootstrap's guarded DO block, so a
      // head-only slice ("DO $$\n") would wrongly skip them.
      const isDoBlock = trimmed.startsWith("DO $$");
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && !isDoBlock) {
        continue;
      }
      try {
        await kindPool.query(q.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (kindPool) {
      await kindPool.query(`DROP SCHEMA IF EXISTS "${KIND_SCHEMA}" CASCADE`);
      await kindPool.end();
    }
  });

  it("agent_kind is NOT NULL text defaulting to 'executor'; assistant_config is nullable text", async () => {
    const { rows } = await kindPool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_templates' AND column_name = ANY($2)`,
      [KIND_SCHEMA, ["agent_kind", "assistant_config"]],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(byName.agent_kind.data_type).toBe("text");
    expect(byName.agent_kind.is_nullable).toBe("NO");
    expect(byName.agent_kind.column_default).toContain("'executor'");
    expect(byName.assistant_config.data_type).toBe("text");
    expect(byName.assistant_config.is_nullable).toBe("YES");
  });

  it("both invariant CHECK constraints + the kind index exist", async () => {
    const { rows: cons } = await kindPool.query(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'agent_templates' AND c.contype = 'c'`,
      [KIND_SCHEMA],
    );
    const names = cons.map((r) => r.conname);
    expect(names).toContain("agent_templates_agent_kind_check");
    expect(names).toContain("agent_templates_agent_kind_config_check");
    const { rows: idx } = await kindPool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'agent_templates' AND indexname = 'agent_templates_agent_kind_idx'`,
      [KIND_SCHEMA],
    );
    expect(idx.length).toBe(1);
  });

  const baseCols =
    "(id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, agent_kind, assistant_config)";
  const baseVals = "'', '[]', '{}', '{\"steps\":[]}'";

  it("an executor row with NO assistant_config is accepted (the default shape)", async () => {
    await expect(
      kindPool.query(
        `INSERT INTO "${KIND_SCHEMA}".agent_templates ${baseCols}
         VALUES ($1, 'executor-ok', ${baseVals}, '@t/executor-ok', 'executor', NULL)`,
        ["k-executor-ok"],
      ),
    ).resolves.toBeDefined();
  });

  it("an executor row WITH an assistant_config is REJECTED by the pairing CHECK", async () => {
    await expect(
      kindPool.query(
        `INSERT INTO "${KIND_SCHEMA}".agent_templates ${baseCols}
         VALUES ($1, 'executor-bad', ${baseVals}, '@t/executor-bad', 'executor', '{"persona":"x","skillBundle":[]}')`,
        ["k-executor-bad"],
      ),
    ).rejects.toThrow(/agent_kind_config_check/);
  });

  it("an assistant row WITH an assistant_config is accepted", async () => {
    await expect(
      kindPool.query(
        `INSERT INTO "${KIND_SCHEMA}".agent_templates ${baseCols}
         VALUES ($1, 'asst-ok', ${baseVals}, '@t/asst-ok', 'assistant', '{"persona":"Cinatra","skillBundle":["chat-assistant-core"]}')`,
        ["k-asst-ok"],
      ),
    ).resolves.toBeDefined();
  });

  it("an assistant row WITHOUT an assistant_config is REJECTED by the pairing CHECK", async () => {
    await expect(
      kindPool.query(
        `INSERT INTO "${KIND_SCHEMA}".agent_templates ${baseCols}
         VALUES ($1, 'asst-bad', ${baseVals}, '@t/asst-bad', 'assistant', NULL)`,
        ["k-asst-bad"],
      ),
    ).rejects.toThrow(/agent_kind_config_check/);
  });

  it("an unknown agent_kind is REJECTED by the kind CHECK", async () => {
    await expect(
      kindPool.query(
        `INSERT INTO "${KIND_SCHEMA}".agent_templates ${baseCols}
         VALUES ($1, 'kind-bad', ${baseVals}, '@t/kind-bad', 'project', NULL)`,
        ["k-kind-bad"],
      ),
    ).rejects.toThrow(/agent_kind_check/);
  });

  it("an unspecified agent_kind defaults to 'executor'", async () => {
    await kindPool.query(
      `INSERT INTO "${KIND_SCHEMA}".agent_templates
         (id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
       VALUES ($1, 'default-kind', '', '[]', '{}', '{"steps":[]}', '@t/default-kind')`,
      ["k-default"],
    );
    const { rows } = await kindPool.query(
      `SELECT agent_kind, assistant_config FROM "${KIND_SCHEMA}".agent_templates WHERE id = $1`,
      ["k-default"],
    );
    expect(rows[0]).toEqual({ agent_kind: "executor", assistant_config: null });
  });
});
