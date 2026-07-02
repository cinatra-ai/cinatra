import { describe, expect, it } from "vitest";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { aliasCinatraCube } from "../define-cube";
import { createAgentRunsCube } from "../cubes/agent-runs";

function baseAgentRunsCube() {
  const agentRuns = pgTable("agent_runs", {
    id: text("id").primaryKey(),
    templateId: text("template_id"),
    status: text("status"),
    createdAt: timestamp("created_at"),
    orgId: text("org_id"),
    runBy: text("run_by"),
  });
  const agentTemplates = pgTable("agent_templates", { id: text("id").primaryKey(), name: text("name") });
  return createAgentRunsCube({
    tableRef: agentRuns,
    columns: {
      id: agentRuns.id,
      templateId: agentRuns.templateId,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      orgId: agentRuns.orgId,
      runBy: agentRuns.runBy,
    },
    templatesTableRef: agentTemplates,
    templateColumns: { id: agentTemplates.id, name: agentTemplates.name },
  });
}

describe("aliasCinatraCube", () => {
  it("derives an alias with a new id + member subset, reusing the base SQL build", () => {
    const base = baseAgentRunsCube();
    const alias = aliasCinatraCube(base, "ext_runs", ["count", "status"]);
    expect(alias.descriptor.id).toBe("ext_runs");
    const members = [
      ...alias.descriptor.dimensions.map((d) => d.id),
      ...alias.descriptor.measures.map((m) => m.id),
    ];
    expect(new Set(members)).toEqual(new Set(["count", "status"]));
    // SAME host build object (so the tenant predicate is the base cube's exact closure).
    expect(alias.build).toBe(base.build);
  });

  it("throws on an empty aliasId / an id equal to the base / an empty member set", () => {
    const base = baseAgentRunsCube();
    expect(() => aliasCinatraCube(base, "", ["count"])).toThrow();
    expect(() => aliasCinatraCube(base, "agent_runs", ["count"])).toThrow(/differ/);
    expect(() => aliasCinatraCube(base, "ext_runs", [])).toThrow(/at least one member/);
  });

  it("throws on a member the base cube does not publish (no smuggled column)", () => {
    const base = baseAgentRunsCube();
    expect(() => aliasCinatraCube(base, "ext_runs", ["count", "secret_column"])).toThrow(/not published/);
  });
});
