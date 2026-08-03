// REAL-POSTGRES proof for `agent_assigned_skills` (cinatra#2346 S1, epic #2345).
//
// Two things cannot be proven with a query double, and both are acceptance
// criteria:
//
//   1. FRESH vs EXISTING DATABASE. The table has two homes — the fresh-install
//      bootstrap DDL and the operator-upgrade migration core__0089. This suite
//      applies EACH to its own schema and proves they converge on the same
//      table, so an upgraded instance and a fresh install cannot diverge.
//   2. THE RACE AT THE CAP BOUNDARY. `pg_advisory_xact_lock` serializes only
//      across real transactions on real connections; the unique
//      (agent_package_name, "position") index only bites in a real database.
//      Two concurrent assigns at the cap must not both land.
//
// Runner (the repo's standing DB-integration contract — the file tier is
// excluded from the default run):
//
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/__tests__/agent-assigned-skills.integration.test.ts
//
// Each arm gets its own lane-unique schema, dropped in `afterAll`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  AGENT_ASSIGNED_SKILLS_POSITION_INDEX,
  AGENT_ASSIGNED_SKILLS_TABLE,
  agentAssignedSkillsSchemaQueries,
} from "@/lib/skill-lifecycle-schema";
import { agentAssignedSkillsDdlSql } from "../../../migrations/core/core__0089_agent-assigned-skills.mjs";
import {
  AGENT_ASSIGNED_SKILLS_CAP,
  deleteAssignedSkill,
  insertAssignedSkill,
  readAssignedSkillsForAgentPackage,
  type AssignedSkillsQuery,
  type AssignedSkillsStoreDeps,
} from "@/lib/agent-assigned-skills-store";

const CONNECTION = process.env.SUPABASE_DB_URL ?? "";
const RUN = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && CONNECTION.length > 0;

const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const FRESH_SCHEMA = `t2346_fresh_${suffix}`;
const UPGRADE_SCHEMA = `t2346_upgrade_${suffix}`;

let pool: Pool;

/** Store deps bound to a schema, each transaction on its OWN pooled client so
 *  the advisory lock genuinely serializes two concurrent callers. */
function depsFor(schema: string): AssignedSkillsStoreDeps {
  const query: AssignedSkillsQuery = async <T = unknown>(
    text: string,
    values?: readonly unknown[],
  ) => {
    const res = await pool.query(text, values ? [...values] : undefined);
    return res.rows as T[];
  };
  return {
    schema,
    query,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const txQuery: AssignedSkillsQuery = async <T = unknown>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const res = await client.query(text, values ? [...values] : undefined);
          return res.rows as T[];
        };
        const out = await fn(txQuery);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the original error matters */
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/** The observable shape of the table in one schema. */
async function describeTable(schema: string) {
  const columns = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY column_name`,
    [schema, AGENT_ASSIGNED_SKILLS_TABLE],
  );
  const indexes = await pool.query(
    `SELECT i.relname AS name, ix.indisunique AS is_unique,
            pg_get_indexdef(ix.indexrelid) AS def
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY i.relname`,
    [schema, AGENT_ASSIGNED_SKILLS_TABLE],
  );
  return {
    columns: columns.rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable,
      // The schema name appears in no default here, but normalize anyway so the
      // two arms are comparable.
      default: r.column_default === null ? null : String(r.column_default).replaceAll(schema, "<schema>"),
    })),
    indexes: indexes.rows.map((r) => ({
      name: r.name,
      unique: r.is_unique,
      def: String(r.def).replaceAll(schema, "<schema>"),
    })),
  };
}

beforeAll(async () => {
  if (!RUN) return;
  pool = new Pool({ connectionString: CONNECTION, max: 8 });

  // --- ARM A: FRESH DATABASE -------------------------------------------------
  // A brand-new instance runs the bootstrap schema builder and nothing else.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${FRESH_SCHEMA}"`);
  for (const q of agentAssignedSkillsSchemaQueries(FRESH_SCHEMA)) {
    await pool.query(q.text);
  }

  // --- ARM B: EXISTING DATABASE ---------------------------------------------
  // An already-running instance: the schema exists (with unrelated tables) but
  // NEVER re-runs the bootstrap for a table added later. Only the executable
  // migration can create it — which is exactly why a manifest fragment alone
  // would not have been enough.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${UPGRADE_SCHEMA}"`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${UPGRADE_SCHEMA}"."custom_skill_assignments" (
       skill_id text NOT NULL, agent_id text NOT NULL, PRIMARY KEY (skill_id, agent_id))`,
  );
}, 120_000);

afterAll(async () => {
  if (!RUN || !pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${FRESH_SCHEMA}" CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS "${UPGRADE_SCHEMA}" CASCADE`);
  await pool.end();
}, 120_000);

describe.skipIf(!RUN)("agent_assigned_skills — fresh install vs operator upgrade", () => {
  it("ARM A (fresh database): the bootstrap DDL creates the table", async () => {
    const shape = await describeTable(FRESH_SCHEMA);
    expect(shape.columns.map((c) => c.name)).toEqual([
      "agent_package_name",
      "created_at",
      "created_by",
      "position",
      "skill_id",
    ]);
    expect(shape.columns.find((c) => c.name === "created_by")!.nullable).toBe("NO");
    expect(shape.columns.find((c) => c.name === "position")!.type).toBe("integer");
    expect(
      shape.indexes.find((i) => i.name === AGENT_ASSIGNED_SKILLS_POSITION_INDEX)!.unique,
    ).toBe(true);
  });

  it("ARM B (existing database): the table is ABSENT until the migration runs", async () => {
    const before = await describeTable(UPGRADE_SCHEMA);
    expect(before.columns).toEqual([]);

    // Exactly how node-pg-migrate runs it: the schema is on the search_path and
    // the migration's SQL is unqualified.
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${UPGRADE_SCHEMA}"`);
      await client.query(agentAssignedSkillsDdlSql);
    } finally {
      client.release();
    }

    const after = await describeTable(UPGRADE_SCHEMA);
    expect(after.columns.map((c) => c.name)).toContain("agent_package_name");
  });

  it("both arms converge on the SAME table shape (no split-brain)", async () => {
    const fresh = await describeTable(FRESH_SCHEMA);
    const upgraded = await describeTable(UPGRADE_SCHEMA);
    expect(upgraded.columns).toEqual(fresh.columns);
    expect(upgraded.indexes).toEqual(fresh.indexes);
  });

  it("both halves are IDEMPOTENT (either may run after the other)", async () => {
    // Bootstrap over the migrated schema…
    for (const q of agentAssignedSkillsSchemaQueries(UPGRADE_SCHEMA)) {
      await expect(pool.query(q.text)).resolves.toBeDefined();
    }
    // …and the migration over the bootstrapped schema.
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${FRESH_SCHEMA}"`);
      await expect(client.query(agentAssignedSkillsDdlSql)).resolves.toBeDefined();
    } finally {
      client.release();
    }
    expect((await describeTable(FRESH_SCHEMA)).columns).toEqual(
      (await describeTable(UPGRADE_SCHEMA)).columns,
    );
  });

  it("the down() migration drops the table and the bootstrap can re-create it", async () => {
    const scratch = `${UPGRADE_SCHEMA}_down`;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${scratch}"`);
    try {
      for (const q of agentAssignedSkillsSchemaQueries(scratch)) await pool.query(q.text);
      expect((await describeTable(scratch)).columns.length).toBeGreaterThan(0);
      const mod = await import("../../../migrations/core/core__0089_agent-assigned-skills.mjs");
      const statements: string[] = [];
      mod.down({ sql: (s: string) => statements.push(s) } as never);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${scratch}"`);
        for (const s of statements) await client.query(s);
      } finally {
        client.release();
      }
      expect((await describeTable(scratch)).columns).toEqual([]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${scratch}" CASCADE`);
    }
  });
});

describe.skipIf(!RUN)("the atomic 3-cap against a real Postgres", () => {
  const AGENT = "@cinatra-ai/web-scrape-agent";

  async function reset() {
    await pool.query(`TRUNCATE TABLE "${FRESH_SCHEMA}"."${AGENT_ASSIGNED_SKILLS_TABLE}"`);
  }

  it("assigns three in order and REFUSES the fourth", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    for (let i = 1; i <= AGENT_ASSIGNED_SKILLS_CAP; i++) {
      const out = await insertAssignedSkill(
        { agentPackageName: AGENT, skillId: `@p/s:${i}`, createdBy: "admin_1" },
        deps,
      );
      expect(out.outcome).toBe("assigned");
    }
    const fourth = await insertAssignedSkill(
      { agentPackageName: AGENT, skillId: "@p/s:4", createdBy: "admin_1" },
      deps,
    );
    expect(fourth).toEqual({ outcome: "cap_exceeded", count: AGENT_ASSIGNED_SKILLS_CAP });
    const rows = await readAssignedSkillsForAgentPackage(AGENT, deps);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.skillId)).toEqual(["@p/s:1", "@p/s:2", "@p/s:3"]);
  });

  it("RACE: two concurrent inserts at the cap boundary cannot both land", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    // Seed to one slot below the cap, so exactly one of the two racers may win.
    for (let i = 1; i <= AGENT_ASSIGNED_SKILLS_CAP - 1; i++) {
      await insertAssignedSkill(
        { agentPackageName: AGENT, skillId: `@p/s:${i}`, createdBy: "admin_1" },
        deps,
      );
    }
    const [a, b] = await Promise.all([
      insertAssignedSkill(
        { agentPackageName: AGENT, skillId: "@p/race:a", createdBy: "admin_1" },
        deps,
      ),
      insertAssignedSkill(
        { agentPackageName: AGENT, skillId: "@p/race:b", createdBy: "admin_2" },
        deps,
      ),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["assigned", "cap_exceeded"]);
    const rows = await readAssignedSkillsForAgentPackage(AGENT, deps);
    expect(rows).toHaveLength(AGENT_ASSIGNED_SKILLS_CAP);
    // Positions stay dense and unique — the serialization held.
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it("RACE: many concurrent inserts from an EMPTY state land exactly the cap", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        insertAssignedSkill(
          { agentPackageName: AGENT, skillId: `@p/burst:${i}`, createdBy: "admin_1" },
          deps,
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === "assigned")).toHaveLength(
      AGENT_ASSIGNED_SKILLS_CAP,
    );
    expect(results.filter((r) => r.outcome === "cap_exceeded")).toHaveLength(
      8 - AGENT_ASSIGNED_SKILLS_CAP,
    );
    const rows = await readAssignedSkillsForAgentPackage(AGENT, deps);
    expect(rows).toHaveLength(AGENT_ASSIGNED_SKILLS_CAP);
    // Every position distinct — the UNIQUE (agent_package_name, position) index
    // is the backstop the design names, and nothing tripped it.
    expect(new Set(rows.map((r) => r.position)).size).toBe(AGENT_ASSIGNED_SKILLS_CAP);
  });

  it("RACE: concurrent duplicate assigns collapse to ONE row", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        insertAssignedSkill(
          { agentPackageName: AGENT, skillId: "@p/dup:1", createdBy: "admin_1" },
          deps,
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === "assigned")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_assigned")).toHaveLength(3);
    expect(await readAssignedSkillsForAgentPackage(AGENT, deps)).toHaveLength(1);
  });

  it("the cap is PER AGENT PACKAGE", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    for (let i = 1; i <= AGENT_ASSIGNED_SKILLS_CAP; i++) {
      await insertAssignedSkill(
        { agentPackageName: AGENT, skillId: `@p/s:${i}`, createdBy: "admin_1" },
        deps,
      );
    }
    const other = await insertAssignedSkill(
      { agentPackageName: "@cinatra-ai/other-agent", skillId: "@p/s:1", createdBy: "admin_1" },
      deps,
    );
    expect(other.outcome).toBe("assigned");
  });

  it("the UNIQUE (agent_package_name, position) index refuses a duplicate slot", async () => {
    await reset();
    const deps = depsFor(FRESH_SCHEMA);
    await insertAssignedSkill(
      { agentPackageName: AGENT, skillId: "@p/s:1", createdBy: "admin_1" },
      deps,
    );
    // A hypothetical writer that bypassed the store and reused position 1.
    await expect(
      pool.query(
        `INSERT INTO "${FRESH_SCHEMA}"."${AGENT_ASSIGNED_SKILLS_TABLE}"
           (agent_package_name, skill_id, "position", created_by)
         VALUES ($1, $2, 1, $3)`,
        [AGENT, "@p/s:other", "admin_1"],
      ),
    ).rejects.toThrow(/duplicate key value|unique constraint/i);
  });
});

describe.skipIf(!RUN)("removal down to zero, against real SQL", () => {
  const AGENT = "@cinatra-ai/removal-agent";

  it("removes each row and then reports nothing left", async () => {
    const deps = depsFor(FRESH_SCHEMA);
    await pool.query(
      `DELETE FROM "${FRESH_SCHEMA}"."${AGENT_ASSIGNED_SKILLS_TABLE}" WHERE agent_package_name = $1`,
      [AGENT],
    );
    for (const id of ["@p/a:1", "@p/b:1"]) {
      await insertAssignedSkill({ agentPackageName: AGENT, skillId: id, createdBy: "a" }, deps);
    }
    expect(await readAssignedSkillsForAgentPackage(AGENT, deps)).toHaveLength(2);

    await expect(
      deleteAssignedSkill({ agentPackageName: AGENT, skillId: "@p/a:1" }, deps),
    ).resolves.toEqual({ deleted: true });
    await expect(
      deleteAssignedSkill({ agentPackageName: AGENT, skillId: "@p/b:1" }, deps),
    ).resolves.toEqual({ deleted: true });
    expect(await readAssignedSkillsForAgentPackage(AGENT, deps)).toEqual([]);

    // Idempotent: a completed uninstall teardown and the UI remove button can
    // both have run.
    await expect(
      deleteAssignedSkill({ agentPackageName: AGENT, skillId: "@p/b:1" }, deps),
    ).resolves.toEqual({ deleted: false });
  });

  it("a removal frees a slot, and the next assign takes a fresh position", async () => {
    const deps = depsFor(FRESH_SCHEMA);
    await pool.query(
      `DELETE FROM "${FRESH_SCHEMA}"."${AGENT_ASSIGNED_SKILLS_TABLE}" WHERE agent_package_name = $1`,
      [AGENT],
    );
    for (let i = 1; i <= AGENT_ASSIGNED_SKILLS_CAP; i++) {
      await insertAssignedSkill(
        { agentPackageName: AGENT, skillId: `@p/s:${i}`, createdBy: "a" },
        deps,
      );
    }
    await deleteAssignedSkill({ agentPackageName: AGENT, skillId: "@p/s:2" }, deps);
    const out = await insertAssignedSkill(
      { agentPackageName: AGENT, skillId: "@p/s:new", createdBy: "a" },
      deps,
    );
    expect(out.outcome).toBe("assigned");
    const rows = await readAssignedSkillsForAgentPackage(AGENT, deps);
    // Ordering is what matters, not density: insertion order is preserved.
    expect(rows.map((r) => r.skillId)).toEqual(["@p/s:1", "@p/s:3", "@p/s:new"]);
    expect(rows).toHaveLength(AGENT_ASSIGNED_SKILLS_CAP);
  });
});
