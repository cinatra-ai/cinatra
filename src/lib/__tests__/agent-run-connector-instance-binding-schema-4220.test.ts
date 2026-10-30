import { describe, expect, it, vi } from "vitest";
import { agentRuns } from "../../../packages/agents/src/schema";
import { agentRunConnectorInstanceBindingSchemaQueries } from "../agent-run-created-at-schema";
import { buildCreateStoreSchemaQueries } from "../drizzle-store";
import { up, down } from "../../../migrations/core/core__0114_agent-run-connector-instance-binding.mjs";

const normalized = (sql: string) => sql.replaceAll(/"cinatra_fixture"\./g, "").replaceAll('"agent_runs"', "agent_runs").replaceAll(/\s+/g, " ").trim().replace(/;$/, "");

describe("cinatra#4220 agent-run connector-instance binding column: upgrade and fresh-store parity", () => {
  it("declares one nullable text column", () => {
    expect(agentRuns.connectorInstanceBinding.name).toBe("connector_instance_binding");
    expect(agentRuns.connectorInstanceBinding.notNull).toBe(false);
  });

  it("the operator upgrade and the bootstrap twin emit the exact same additive DDL", () => {
    const sql = vi.fn();
    // The migration's only builder capability is sql; no database is started.
    up({ sql });
    const operator = String(sql.mock.calls[0][0]).trim().split(";").map(normalized).filter(Boolean);
    const bootstrap = agentRunConnectorInstanceBindingSchemaQueries("cinatra_fixture").map(row => normalized(row.text));
    expect(operator).toEqual(bootstrap);
    expect(operator).toHaveLength(1);
    for (const stmt of operator) expect(stmt).not.toMatch(/\b(?:UPDATE|DELETE|CASCADE|REFERENCES)\b/i);
    expect(operator[0]).toContain("ADD COLUMN IF NOT EXISTS connector_instance_binding text");
  });

  it("the actual bootstrap adds the column once, after the agent_runs CREATE TABLE", () => {
    const all = buildCreateStoreSchemaQueries("cinatra_fixture").map(row => row.text);
    const twin = agentRunConnectorInstanceBindingSchemaQueries("cinatra_fixture").map(row => row.text);
    expect(twin).toHaveLength(1);
    expect(all.filter(row => row === twin[0])).toHaveLength(1);
    const table = '"cinatra_fixture"."agent_runs"';
    const create = all.findIndex(row => row.startsWith(`CREATE TABLE IF NOT EXISTS ${table}`));
    expect(create).toBeGreaterThan(-1);
    expect(all.indexOf(twin[0])).toBeGreaterThan(create);
  });

  it("quotes schema identifiers and rolls back only the new column", () => {
    expect(agentRunConnectorInstanceBindingSchemaQueries('we"ird').every(row => row.text.includes('"we""ird"."agent_runs"'))).toBe(true);
    const sql = vi.fn();
    down({ sql });
    const statements = String(sql.mock.calls[0][0]);
    expect(statements).toContain("DROP COLUMN IF EXISTS connector_instance_binding");
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|CASCADE|DROP TABLE)\b/i);
  });
});
