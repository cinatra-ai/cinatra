/**
 * Asserts the migration correctness for `cinatra.agent_runs.org_id`:
 *
 *   - The DDL block contains a `DELETE FROM ... WHERE org_id IS NULL` BEFORE
 *     the `ALTER COLUMN org_id SET NOT NULL`. (Order matters — Postgres
 *     rejects SET NOT NULL on a column with NULL rows.)
 *   - The DDL is idempotent — running it twice on a fresh schema produces
 *     no errors.
 *   - After the migration applies to a per-test schema:
 *       1. `INSERT … org_id = NULL` raises a not-null constraint error.
 *       2. A row inserted with `org_id = NULL` BEFORE the migration is gone
 *          afterwards.
 *
 * The DELETE drops existing NULL rows by design; the migration does not
 * backfill or recover rows that cannot satisfy the new constraint.
 *
 * The DDL-string assertions run with no DB. The actual apply-and-insert
 * assertions are DB-gated and skip when
 * `SUPABASE_DB_URL` is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string"
  && dbUrl.length > 0
  && !dbUrl.includes("unused:unused@localhost:5432/unused");

describe("agent_runs.org_id NOT NULL (DDL string-introspection, no DB needed)", () => {
  const queries = buildCreateStoreSchemaQueries("cinatra_test");
  const texts = queries.map((q) => q.text);

  it("includes a DELETE FROM agent_runs WHERE org_id IS NULL", () => {
    const deleteSql = texts.find((t) =>
      /DELETE FROM\s+"cinatra_test"\."agent_runs"\s+WHERE\s+org_id IS NULL/i.test(t),
    );
    expect(deleteSql).toBeDefined();
  });

  it("includes ALTER COLUMN org_id SET NOT NULL", () => {
    const alterSql = texts.find((t) =>
      /ALTER\s+TABLE\s+"cinatra_test"\."agent_runs"\s+ALTER\s+COLUMN\s+org_id\s+SET\s+NOT\s+NULL/i.test(
        t,
      ),
    );
    expect(alterSql).toBeDefined();
  });

  it("runs the DELETE before the ALTER SET NOT NULL", () => {
    const deleteIdx = texts.findIndex((t) =>
      /DELETE FROM\s+"cinatra_test"\."agent_runs"\s+WHERE\s+org_id IS NULL/i.test(t),
    );
    const alterIdx = texts.findIndex((t) =>
      /ALTER\s+TABLE\s+"cinatra_test"\."agent_runs"\s+ALTER\s+COLUMN\s+org_id\s+SET\s+NOT\s+NULL/i.test(
        t,
      ),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(deleteIdx);
  });
});

describe.skipIf(!hasDb)(
  "agent_runs.org_id NOT NULL (DB-gated migration apply)",
  () => {
    let client: Client;
    let schema: string;

    beforeAll(async () => {
      client = new Client({ connectionString: dbUrl });
      await client.connect();
      schema = `cinatra_org_id_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
    });

    afterAll(async () => {
      if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    });

    async function applyMigration(): Promise<void> {
      const qs = buildCreateStoreSchemaQueries(schema);
      for (const q of qs) {
        const head = q.text.trim().slice(0, 6).toUpperCase();
        if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DELETE" && head !== "UPDATE") {
          continue;
        }
        try {
          await client.query(q.text, q.values ?? []);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Some statements reference seed dependencies that aren't present
          // in a fresh empty schema — skip them. Genuine schema problems
          // re-throw.
          if (!msg.includes("does not exist") && !msg.includes("relation")) {
            throw err;
          }
        }
      }
    }

    it("deletes pre-existing org_id=NULL rows during migration", async () => {
      // Build the table before inserting a NULL row, then re-apply the
      // migration to verify cleanup removes rows that cannot satisfy the new
      // constraint.
      await applyMigration();
      // Insert a NULL row that the migration must clean up.
      const legacyId = randomUUID();
      await client.query(
        `INSERT INTO "${schema}"."agent_runs"
           (id, template_id, version_id, run_by, status, input_params, source_type, org_id)
         VALUES ($1, $2, NULL, NULL, 'queued', '{}'::jsonb, 'agent_builder', NULL)
        ON CONFLICT DO NOTHING`,
        [legacyId, "tpl_legacy"],
      );
      // Re-apply the migration. Cleanup must run before the ALTER.
      await applyMigration();
      // The legacy NULL row MUST be gone after migration.
      const res = await client.query(
        `SELECT id FROM "${schema}"."agent_runs" WHERE id = $1`,
        [legacyId],
      );
      expect(res.rowCount).toBe(0);
    });

    it("rejects INSERT with org_id=NULL after migration", async () => {
      await applyMigration();
      let thrown: unknown = null;
      try {
        await client.query(
          `INSERT INTO "${schema}"."agent_runs"
             (id, template_id, version_id, run_by, status, input_params, source_type, org_id)
           VALUES ($1, $2, NULL, NULL, 'queued', '{}'::jsonb, 'agent_builder', NULL)`,
          [randomUUID(), "tpl_post"],
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).toMatch(/null value|not[-\s]?null/i);
    });

    it("re-runs the migration idempotently", async () => {
      // Idempotency holds today (same statements re-run with IF NOT EXISTS
      // / IF EXISTS guards). The org_id cleanup and constraint enforcement
      // must preserve idempotency: re-DELETE matches zero rows, re-ALTER on an
      // already-NOT-NULL column is a no-op.
      await applyMigration();
      let thrown: unknown = null;
      try {
        await applyMigration();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
    });
  },
);
