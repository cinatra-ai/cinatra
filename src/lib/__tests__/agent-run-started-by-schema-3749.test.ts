import { describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentRuns } from "../../../packages/agents/src/schema";
import { agentRunStartedBySchemaQueries } from "../agent-run-created-at-schema";
import { buildCreateStoreSchemaQueries } from "../drizzle-store";
import { up, down } from "../../../migrations/core/core__0111_agent-run-started-by.mjs";

const normalized = (sql: string) => sql.replaceAll(/"cinatra_fixture"\./g, "").replaceAll('"agent_runs"', "agent_runs").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");

describe("started-run provenance upgrade and fresh-store parity", () => {
  it("declares one nullable independent starter key and its nonunique scoped index", () => {
    expect(agentRuns.startedByRunId.name).toBe("started_by_run_id");
    expect(agentRuns.startedByRunId.notNull).toBe(false);
    expect(agentRuns.parentRunId.name).toBe("parent_run_id");
    const table = getTableConfig(agentRuns);
    const index = table.indexes.find(row => row.config.name === "agent_runs_started_by_run_id_idx");
    expect(index?.config.unique).toBe(false);
    expect(index?.config.columns.map(column => "name" in column ? column.name : "expression")).toEqual(["started_by_run_id", "org_id", "created_at"]);
    expect(table.foreignKeys.some(fk => fk.reference().columns.some(column => column.name === "started_by_run_id"))).toBe(false);
  });

  it("the maintained operator upgrade and bootstrap emit the exact same additive DDL", () => {
    const sql = vi.fn();
    // The migration's only builder capability is sql; no database is started.
    up({ sql });
    const operator = String(sql.mock.calls[0][0]).trim().split(";").map(normalized).filter(Boolean);
    const bootstrap = agentRunStartedBySchemaQueries("cinatra_fixture").map(row => normalized(row.text));
    expect(operator).toEqual(bootstrap);
    expect(operator).toHaveLength(2);
    for (const stmt of operator) expect(stmt).not.toMatch(/\b(?:UPDATE|DELETE|CASCADE|REFERENCES)\b/i);
    expect(operator[0]).toContain("ADD COLUMN IF NOT EXISTS started_by_run_id text");
    expect(operator[1]).toContain("WHERE started_by_run_id IS NOT NULL");
  });

  it("the actual bootstrap creates every indexed starter column before its index", () => {
    const all = buildCreateStoreSchemaQueries("cinatra_fixture").map(row => row.text);
    const starter = agentRunStartedBySchemaQueries("cinatra_fixture").map(row => row.text);
    for (const stmt of starter) expect(all.filter(row => row === stmt)).toHaveLength(1);
    const table = '"cinatra_fixture"."agent_runs"';
    const create = all.findIndex(row => row.startsWith(`CREATE TABLE IF NOT EXISTS ${table}`));
    expect(create).toBeGreaterThan(-1);
    // Fresh stores get org_id later; an existing-store-only check misses this.
    expect(all[create]).not.toMatch(/\borg_id\b/);
    const indexPosition = all.indexOf(starter[1]);
    for (const column of ["created_at", "org_id", "started_by_run_id"]) {
      const position = all.findIndex(row => row.startsWith(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} `));
      expect(position, `bootstrap establishes ${column}`).toBeGreaterThan(create);
      expect(indexPosition, `starter index follows ${column}`).toBeGreaterThan(position);
    }
    expect(all.filter(row => row.includes("started_by_run_id")).join("\n")).not.toMatch(/\b(?:UPDATE|DELETE|CASCADE|REFERENCES)\b/i);
  });

  it("quotes schema identifiers and rolls back only the new key/index, preserving child rows", () => {
    expect(agentRunStartedBySchemaQueries('we"ird').every(row => row.text.includes('"we""ird"."agent_runs"'))).toBe(true);
    const sql = vi.fn();
    down({ sql });
    const statements = String(sql.mock.calls[0][0]);
    expect(statements).toContain("DROP INDEX IF EXISTS agent_runs_started_by_run_id_idx");
    expect(statements).toContain("DROP COLUMN IF EXISTS started_by_run_id");
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|CASCADE|parent_run_id)\b/i);
  });
});
