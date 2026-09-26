import { describe, expect, it } from "vitest";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDrizzleSemanticLayer } from "drizzle-cube/server";

import { AGENT_RUNS_CUBE_DESCRIPTOR, createAgentRunsCube } from "../cubes/agent-runs";

/**
 * A SCOPE'S EXECUTIONS LIST ITS OWN RUNS — A LISTING FILTER, NEVER AN ACCESS
 * RULE (cinatra#3693).
 *
 * cinatra#3693's second done-when sentence: "The Executions and Reviews lists
 * are reachable from each scope and list that scope's runs and reviews, or the
 * drawing says where a scope's runs are listed and the product follows it." The
 * drawing: "Executions lists the runs started in that scope, and the
 * workspace's Executions lists every run the viewer may see."
 *
 * A3 (the SQL half) — the cube carries ONE new dimension read off the run's
 * immutable launch-scope anchor, so a portlet can narrow what it lists to the
 * runs started in one scope. The access predicate (`org_id IN (...) OR run_by =
 * user`) is untouched: the filter only narrows a read that is already
 * authorized, and it is bound, never spliced. No live Postgres: drizzle-cube's
 * `generateSQL` renders the statement without running it.
 */
describe("agent_runs cube — the launch-scope listing filter (cinatra#3693)", () => {
  const fakeAgentRuns = pgTable("agent_runs", {
    id: text("id").primaryKey(),
    templateId: text("template_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title"),
    orgId: text("org_id").notNull(),
    runBy: text("run_by"),
    launchScopeAnchor: jsonb("launch_scope_anchor"),
  });
  const fakeAgentTemplates = pgTable("agent_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    packageName: text("package_name").notNull(),
  });

  function layerWithCube(withAnchor = true) {
    const layer = createDrizzleSemanticLayer({
      drizzle: drizzle({} as never) as never,
      schema: { agentRuns: fakeAgentRuns },
    });
    const cube = createAgentRunsCube({
      tableRef: fakeAgentRuns,
      columns: {
        id: fakeAgentRuns.id,
        templateId: fakeAgentRuns.templateId,
        status: fakeAgentRuns.status,
        createdAt: fakeAgentRuns.createdAt,
        title: fakeAgentRuns.title,
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
        ...(withAnchor ? { launchScopeAnchor: fakeAgentRuns.launchScopeAnchor } : {}),
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
      },
    } as Parameters<typeof createAgentRunsCube>[0]);
    layer.registerCube(cube.dcCube);
    return layer;
  }

  const CTX = { organizationId: "org_acme", userId: "u1", accessibleOrgIds: ["org_acme", "org_b"] };

  it("describes the one new dimension, launch_scope", () => {
    expect(AGENT_RUNS_CUBE_DESCRIPTOR.dimensions.map((d) => d.id)).toContain("launch_scope");
  });

  it("narrows by the run's launch scope with a BOUND value, and keeps the access predicate", async () => {
    const result = await layerWithCube().generateSQL(
      "agent_runs",
      {
        dimensions: ["agent_runs.run_id"],
        filters: [
          { member: "agent_runs.launch_scope", operator: "equals", values: ["organization:org_b"] },
        ],
      } as never,
      CTX,
    );
    expect(result.sql).toMatch(/launch_scope_anchor/);
    expect(result.params ?? []).toContain("organization:org_b");
    // The value is bound, never spliced into the statement.
    expect(result.sql).not.toContain("organization:org_b");
    // The access predicate is still the cube's own.
    expect(result.sql).toMatch(/org_id/);
    expect(result.sql).toMatch(/run_by/);
    expect(result.params ?? []).toEqual(expect.arrayContaining(["org_acme", "org_b", "u1"]));
  });

  it("an unfiltered read never touches the anchor — the workspace-wide set is unchanged", async () => {
    const result = await layerWithCube().generateSQL(
      "agent_runs",
      { dimensions: ["agent_runs.run_id"] } as never,
      CTX,
    );
    expect(result.sql).not.toMatch(/launch_scope_anchor/);
    expect(result.sql).toMatch(/org_id/);
    expect(result.sql).toMatch(/run_by/);
  });

  it("an unfiltered read is byte-identical, SQL and parameters, to a host that passes no anchor column", async () => {
    const query = { dimensions: ["agent_runs.run_id"], measures: ["agent_runs.count"] } as never;
    const withAnchor = await layerWithCube(true).generateSQL("agent_runs", query, CTX);
    const without = await layerWithCube(false).generateSQL("agent_runs", query, CTX);
    expect(withAnchor.sql).toBe(without.sql);
    expect(withAnchor.params ?? []).toEqual(without.params ?? []);
  });

  it("the filtered read keeps the unfiltered read's access predicate verbatim", async () => {
    const unfiltered = await layerWithCube().generateSQL(
      "agent_runs",
      { dimensions: ["agent_runs.run_id"] } as never,
      CTX,
    );
    const filtered = await layerWithCube().generateSQL(
      "agent_runs",
      {
        dimensions: ["agent_runs.run_id"],
        filters: [{ member: "agent_runs.launch_scope", operator: "equals", values: ["team:t1"] }],
      } as never,
      CTX,
    );
    // Whitespace and placeholder numbers are the printer's, not the predicate's.
    const flat = (text: string) => text.replace(/\s+/g, " ").replace(/\$\d+/g, "$?");
    // The unfiltered WHERE clause is the access predicate alone.
    const where = /\bWHERE\b(.*?)(?:\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i.exec(flat(unfiltered.sql))?.[1]?.trim();
    expect(where).toBeTruthy();
    expect(where).toMatch(/org_id.*\bOR\b.*run_by/i);
    expect(flat(filtered.sql)).toContain(where!);
    expect(filtered.params ?? []).toEqual(expect.arrayContaining(["org_acme", "org_b", "u1", "team:t1"]));
  });

  it("the dimension reads the anchor's kind and id joined by a colon", async () => {
    const result = await layerWithCube().generateSQL(
      "agent_runs",
      { dimensions: ["agent_runs.launch_scope"] } as never,
      CTX,
    );
    expect(result.sql.replace(/\s+/g, "")).toContain(
      `concat_ws(':',"agent_runs"."launch_scope_anchor"->>'kind',"agent_runs"."launch_scope_anchor"->>'id')`,
    );
  });

  it("a host that passes no anchor column reads the dimension as the empty string", async () => {
    const result = await layerWithCube(false).generateSQL(
      "agent_runs",
      { dimensions: ["agent_runs.launch_scope"] } as never,
      CTX,
    );
    expect(result.sql).not.toMatch(/launch_scope_anchor/);
    expect(result.sql).toMatch(/''/);
  });
});
