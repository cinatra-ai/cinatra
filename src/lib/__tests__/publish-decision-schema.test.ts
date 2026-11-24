// DDL parity for the publish-decision record (cinatra#4150):
// `agent_run_publish_decisions`.
//
// The table has THREE homes that must agree: the fresh-install bootstrap
// (`buildCreateStoreSchemaQueries`, through the `publishDecisionSchemaQueries`
// leaf), the operator-upgrade migration (`migrations/core/core__0119`) and the
// Drizzle table definition the store reads through. A fresh install and an
// upgraded instance that differ are a silent split-brain.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { publishDecisionSchemaQueries } from "@/lib/artifacts/publication-operation-schema";
import { agentRunPublishDecisions, agentRuns } from "@cinatra-ai/agents/schema";

type MigrationModule = {
  agentRunPublishDecisionsDdlSql: string;
  up: (pgm: { sql: (s: string) => void }) => void;
  down: (pgm: { sql: (s: string) => void }) => void;
};
const loadMigration = async () =>
  (await import("../../../migrations/core/core__0119_agent-run-publish-decisions.mjs")) as unknown as MigrationModule;

const bootstrap = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

/** The column lines of one CREATE TABLE, whitespace normalized; constraints apart. */
function columnsOf(ddl: string): string[] {
  const match = /CREATE TABLE IF NOT EXISTS [^(]*agent_run_publish_decisions[^(]*\(([\s\S]*?)\n\s*\)/.exec(ddl);
  expect(match).not.toBeNull();
  return match![1]
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/,$/, ""))
    .filter((line) => line.length > 0 && !/^(CONSTRAINT|CHECK)\b/.test(line));
}

const STATUS_CHECK = /CHECK \(status IN \('parked', 'released', 'declined', 'expired', 'run_ended'\)\)/;

describe("agent_run_publish_decisions — DDL parity", () => {
  it("the bootstrap creates the table with the closed status set", () => {
    expect(bootstrap).toMatch(/CREATE TABLE IF NOT EXISTS "cinatra"\."agent_run_publish_decisions"/);
    expect(bootstrap).toMatch(STATUS_CHECK);
  });

  it("the bootstrap and the migration declare the same columns, in the same order", async () => {
    const mod = await loadMigration();
    expect(columnsOf(mod.agentRunPublishDecisionsDdlSql)).toEqual(columnsOf(bootstrap));
    expect(mod.agentRunPublishDecisionsDdlSql).toMatch(STATUS_CHECK);
  });

  it("both homes declare the unique key per stop and the partial due index", async () => {
    const mod = await loadMigration();
    for (const ddl of [bootstrap, mod.agentRunPublishDecisionsDdlSql]) {
      expect(ddl).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS agent_run_publish_decisions_park_uniq\s+ON [^(]*\(run_id, node_id, gate_task_id\)/,
      );
      expect(ddl).toMatch(
        /CREATE INDEX IF NOT EXISTS agent_run_publish_decisions_due_idx\s+ON [^(]*\(expires_at\) WHERE status = 'parked'/,
      );
    }
  });

  it("the migration is reversible in the same file, and down() drops only this table", async () => {
    const mod = await loadMigration();
    const up: string[] = [];
    const down: string[] = [];
    mod.up({ sql: (s) => up.push(s) });
    mod.down({ sql: (s) => down.push(s) });
    expect(up.join("\n")).toBe(mod.agentRunPublishDecisionsDdlSql);
    expect(down).toEqual(["DROP TABLE IF EXISTS agent_run_publish_decisions;"]);
  });

  it("the manifest fragment names the migration, its table and an additive change", () => {
    const fragment = JSON.parse(
      readFileSync(
        join(process.cwd(), "migrations/manifest.d/core__0119_agent-run-publish-decisions.json"),
        "utf8",
      ),
    ) as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment).toMatchObject({
      seq: "0119",
      file: "core/core__0119_agent-run-publish-decisions.mjs",
      destructive: false,
      tables: ["agent_run_publish_decisions"],
    });
  });

  // red-first-expect: expected [ Array(15) ] to deeply equal [ Array(16) ]
  it("the Drizzle table matches the DDL's columns, nullability and indexes", async () => {
    const mod = await loadMigration();
    const config = getTableConfig(agentRunPublishDecisions);
    expect(config.name).toBe("agent_run_publish_decisions");
    const ddlColumns = columnsOf(mod.agentRunPublishDecisionsDdlSql).map((line) => ({
      name: line.split(" ")[0],
      notNull: /NOT NULL|PRIMARY KEY/.test(line),
    }));
    // core__0133 adds declared_rows and run_generation, core__0134 released_pause_generation and core__0135
    // calls_in_flight (cinatra#4762), after the table's creation: last, and nullable.
    expect(config.columns.map((c) => ({ name: c.name, notNull: c.notNull }))).toEqual([
      ...ddlColumns,
      { name: "declared_rows", notNull: false },
      { name: "run_generation", notNull: false },
      { name: "released_pause_generation", notNull: false },
      { name: "calls_in_flight", notNull: false },
    ]);
    const indexes = config.indexes.map((i) => ({ name: i.config.name, unique: i.config.unique }));
    expect(indexes).toEqual([
      { name: "agent_run_publish_decisions_park_uniq", unique: true },
      { name: "agent_run_publish_decisions_due_idx", unique: false },
    ]);
  });

  it("the Drizzle table declares the DDL's status CHECK, and each index's columns and predicate", async () => {
    const mod = await loadMigration();
    const config = getTableConfig(agentRunPublishDecisions);
    const dialect = new PgDialect();
    const drizzle = {
      checks: config.checks.map((c) => ({ name: c.name, body: dialect.sqlToQuery(c.value).sql })),
      indexes: config.indexes.map((i) => ({
        name: i.config.name,
        unique: i.config.unique,
        columns: i.config.columns.map((c) => (c as { name: string }).name),
        where: i.config.where ? dialect.sqlToQuery(i.config.where).sql : null,
      })),
    };
    const homes = [mod.agentRunPublishDecisionsDdlSql, publishDecisionSchemaQueries("cinatra").map((x) => x.text).join(";\n") + ";"];
    for (const home of homes) {
      const ddl = home.replace(/\s+/g, " ");
      const checks = [...ddl.matchAll(/CONSTRAINT (\w+) CHECK \((.*?\))\) \);/g)].map((m) => ({ name: m[1], body: m[2] }));
      const indexes = [...ddl.matchAll(/CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON \S+ \(([^)]*)\)(?: WHERE ([^;]*))?;/g)].map((m) => ({
        name: m[2],
        unique: m[1] !== undefined,
        columns: m[3].split(", "),
        where: m[4] ?? null,
      }));
      expect(checks).toHaveLength(1);
      expect(indexes).toHaveLength(2);
      expect(drizzle).toEqual({ checks, indexes });
    }
  });
});

// Review finding 2: the decision keeps the rows its template declared at the park, so a recompile never relabels it.
describe("agent_run_publish_decisions.declared_rows — DDL parity (core__0133)", () => {
  type Pgm = { sql: (s: string) => void; noTransaction: () => void };
  type Mod = { publishDecisionDeclaredRowsDdlSql: string; up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };
  const load = async () =>
    (await import("../../../migrations/core/core__0133_publish-decision-declared-rows.mjs")) as unknown as Mod;
  const record = (fn: (pgm: Pgm) => void) => {
    const out = { sql: [] as string[], noTransaction: 0 };
    fn({ sql: (s) => out.sql.push(s), noTransaction: () => (out.noTransaction += 1) });
    return out;
  };

  // red-first-expect: expected 'CREATE INDEX IF NOT EXISTS agent_run_…' to be 'ALTER TABLE
  it("the bootstrap leaf adds the column, idempotently, once, after the table and its indexes, with the schema quoted", () => {
    const leaf = publishDecisionSchemaQueries('we"ird').map((q) => q.text);
    expect(leaf.at(-4)).toBe('ALTER TABLE "we""ird"."agent_run_publish_decisions" ADD COLUMN IF NOT EXISTS declared_rows text');
    const all = buildCreateStoreSchemaQueries("cinatra").map((q) => q.text);
    expect(all.filter((t) => /agent_run_publish_decisions.* ADD COLUMN IF NOT EXISTS declared_rows text/.test(t))).toHaveLength(1);
  });

  it("the migration adds the same column, idempotently, outside a transaction, under a bounded lock wait", async () => {
    const mod = await load();
    expect(mod.publishDecisionDeclaredRowsDdlSql).toBe(
      "ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS declared_rows text",
    );
    const up = record(mod.up);
    expect(up.noTransaction).toBe(1);
    expect(up.sql).toEqual([
      "SET lock_timeout = 5000",
      "ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS declared_rows text",
      "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS reset_generation integer NOT NULL DEFAULT 0",
      "ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS run_generation integer",
      "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS dispatch_publish_rows text",
      "RESET lock_timeout",
      expect.stringMatching(/^UPDATE agent_run_publish_decisions AS d\s+SET run_generation = COALESCE\(/),
    ]);
  });

  it("down drops only these columns, with IF EXISTS", async () => {
    expect(record((await load()).down).sql).toEqual([
      "ALTER TABLE agent_runs DROP COLUMN IF EXISTS dispatch_publish_rows",
      "ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS run_generation",
      "ALTER TABLE agent_runs DROP COLUMN IF EXISTS reset_generation",
      "ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS declared_rows",
    ]);
  });

  it("the manifest fragment names the migration and its tables, marked destructive for the NOT NULL column and the backfill", () => {
    const fragment = JSON.parse(
      readFileSync(join(process.cwd(), "migrations/manifest.d/core__0133_publish-decision-declared-rows.json"), "utf8"),
    ) as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment).toMatchObject({
      seq: "0133",
      file: "core/core__0133_publish-decision-declared-rows.mjs",
      destructive: true,
      tables: ["agent_run_publish_decisions", "agent_runs"],
    });
  });

  it("the Drizzle column is nullable text with no default (no backfill)", () => {
    const column = getTableConfig(agentRunPublishDecisions).columns.find((c) => c.name === "declared_rows");
    expect(column).toBeDefined();
    expect(column!.notNull).toBe(false);
    expect(column!.hasDefault).toBe(false);
    expect(column!.columnType).toBe("PgText");
  });
});

// Rounds 19 and 20: a decision's reset generation and the run's (the attempt mark), and the dispatched plan's rows, in
// every home.
describe("agent_run_publish_decisions.run_generation, agent_runs.reset_generation and agent_runs.dispatch_publish_rows — DDL parity (core__0133)", () => {
  type Pgm = { sql: (s: string) => void; noTransaction: () => void };
  type Mod = { publishDecisionRunGenerationBackfillSql: string; up: (pgm: Pgm) => void };
  const load = async () =>
    (await import("../../../migrations/core/core__0133_publish-decision-declared-rows.mjs")) as unknown as Mod;

  // red-first-expect: expected 'ALTER TABLE "we""ird"."agent_run_publ…' to be 'ALTER TABLE "we""ird"."agent_run_publ…' // Object.is equality
  it("the bootstrap adds each column, idempotently, exactly once, with the schema quoted", () => {
    const leaf = publishDecisionSchemaQueries('we"ird').map((q) => q.text);
    expect(leaf.at(-3)).toBe('ALTER TABLE "we""ird"."agent_run_publish_decisions" ADD COLUMN IF NOT EXISTS run_generation integer');
    // cinatra#4762 (core__0135): the publishing calls in flight, last.
    expect(leaf.at(-1)).toBe('ALTER TABLE "we""ird"."agent_run_publish_decisions" ADD COLUMN IF NOT EXISTS calls_in_flight integer');
    const all = buildCreateStoreSchemaQueries('we"ird').map((q) => q.text);
    expect(all.filter((t) => t.includes("superseded_at") && t.includes("agent_run_publish_decisions"))).toEqual([]);
    expect(all.filter((t) => /agent_run_publish_decisions.* ADD COLUMN IF NOT EXISTS run_generation/.test(t))).toHaveLength(1);
    expect(all.filter((t) => t.includes("dispatch_publish_rows"))).toEqual([
      'ALTER TABLE "we""ird"."agent_runs" ADD COLUMN IF NOT EXISTS dispatch_publish_rows text',
    ]);
    expect(all.filter((t) => t.includes("reset_generation"))).toEqual([
      'ALTER TABLE "we""ird"."agent_runs" ADD COLUMN IF NOT EXISTS reset_generation integer NOT NULL DEFAULT 0',
    ]);
  });

  it("the Drizzle columns match the bootstrap's types: the run's generation NOT NULL DEFAULT 0, the decision's nullable", () => {
    const columns = getTableConfig(agentRunPublishDecisions).columns.map((c) => c.name);
    expect(columns).not.toContain("superseded_at");
    const runGeneration = getTableConfig(agentRunPublishDecisions).columns.find((c) => c.name === "run_generation");
    expect(runGeneration).toMatchObject({ notNull: false, hasDefault: false, columnType: "PgInteger" });
    const resetGeneration = getTableConfig(agentRuns).columns.find((c) => c.name === "reset_generation");
    expect(resetGeneration).toMatchObject({ notNull: true, hasDefault: true, default: 0, columnType: "PgInteger" });
    const rows = getTableConfig(agentRuns).columns.find((c) => c.name === "dispatch_publish_rows");
    expect(rows).toMatchObject({ notNull: false, hasDefault: false, columnType: "PgText" });
  });

  it("the backfill classifies only rows still NULL, after the columns exist, by the run's status and current attempt start", async () => {
    const mod = await load();
    const sqlText = mod.publishDecisionRunGenerationBackfillSql.replace(/\s+/g, " ");
    expect(sqlText).toBe(
      "UPDATE agent_run_publish_decisions AS d SET run_generation = COALESCE( (SELECT r.reset_generation FROM agent_runs AS r " +
        "WHERE r.id = d.run_id AND r.status <> 'pending_input' AND ((r.started_at IS NOT NULL AND d.created_at >= r.started_at) " +
        "OR (r.started_at IS NULL AND r.status NOT IN ('queued', 'armed', 'pending_trigger') " +
        "AND NOT (r.status = 'pending_approval' AND r.human_wait_attempt_id IS NULL)))), -1) " +
        "WHERE d.run_generation IS NULL",
    );
    const out: string[] = [];
    mod.up({ sql: (t) => out.push(t), noTransaction: () => undefined });
    expect(out.at(-1)).toBe(mod.publishDecisionRunGenerationBackfillSql);
  });
});

// cinatra#4758: the pause generation a release was taken at, so a later read tells a run still parked at that pause from
// one that went on, with no latest-task key. In every home.
describe("agent_run_publish_decisions.released_pause_generation — DDL parity (core__0134)", () => {
  type Pgm = { sql: (s: string) => void; noTransaction: () => void };
  type Mod = { publishDecisionReleasedPauseGenerationDdlSql: string; up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };
  const load = async () =>
    (await import("../../../migrations/core/core__0134_publish-decision-released-pause-generation.mjs")) as unknown as Mod;
  const record = (fn: (pgm: Pgm) => void) => {
    const out = { sql: [] as string[], noTransaction: 0 };
    fn({ sql: (s) => out.sql.push(s), noTransaction: () => (out.noTransaction += 1) });
    return out;
  };

  // red-first-expect: expected 'ALTER TABLE "we""ird"."agent_run_publ…' to be 'ALTER TABLE "we""ird"."agent_run_publ…'
  it("the bootstrap leaf adds the column after run_generation, idempotently, exactly once, with the schema quoted", () => {
    const leaf = publishDecisionSchemaQueries('we"ird').map((q) => q.text);
    // core__0135 (cinatra#4762) adds calls_in_flight after it.
    expect(leaf.at(-2)).toBe('ALTER TABLE "we""ird"."agent_run_publish_decisions" ADD COLUMN IF NOT EXISTS released_pause_generation bigint');
    const all = buildCreateStoreSchemaQueries("cinatra").map((q) => q.text);
    expect(all.filter((t) => t.includes("released_pause_generation"))).toHaveLength(1);
  });

  // red-first-expect: Cannot find module '/migrations/core/core__0134_publish-decision-released-pause-generation.mjs'
  it("the migration adds the same column, idempotently, outside a transaction, under a bounded lock wait, with no backfill", async () => {
    const mod = await load();
    expect(mod.publishDecisionReleasedPauseGenerationDdlSql).toBe(
      "ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS released_pause_generation bigint",
    );
    const up = record(mod.up);
    expect(up.noTransaction).toBe(1);
    expect(up.sql).toEqual([
      "SET lock_timeout = 5000",
      "ALTER TABLE agent_run_publish_decisions ADD COLUMN IF NOT EXISTS released_pause_generation bigint",
      "RESET lock_timeout",
    ]);
    expect(record(mod.down).sql).toEqual([
      "ALTER TABLE agent_run_publish_decisions DROP COLUMN IF EXISTS released_pause_generation",
    ]);
  });

  // red-first-expect: ENOENT: no such file or directory
  it("the manifest fragment names the migration and its one table, not destructive", () => {
    const fragment = JSON.parse(
      readFileSync(join(process.cwd(), "migrations/manifest.d/core__0134_publish-decision-released-pause-generation.json"), "utf8"),
    ) as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment).toMatchObject({
      seq: "0134",
      file: "core/core__0134_publish-decision-released-pause-generation.mjs",
      destructive: false,
      tables: ["agent_run_publish_decisions"],
    });
  });

  // red-first-expect: expected undefined to match object { notNull: false, …(2) }
  it("the Drizzle column is a nullable bigint read as a number, with no default, like the run's pause_generation", () => {
    const column = getTableConfig(agentRunPublishDecisions).columns.find((c) => c.name === "released_pause_generation");
    expect(column).toMatchObject({ notNull: false, hasDefault: false, columnType: "PgBigInt53" });
    const runs = getTableConfig(agentRuns).columns.find((c) => c.name === "pause_generation");
    expect(runs?.columnType).toBe("PgBigInt53");
  });
});
