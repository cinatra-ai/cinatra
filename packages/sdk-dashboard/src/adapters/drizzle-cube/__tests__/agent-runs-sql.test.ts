import { describe, expect, it } from "vitest";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDrizzleSemanticLayer } from "drizzle-cube/server";

import { createAgentRunsCube } from "../cubes/agent-runs";

/**
 * The agent_runs cube's generated SQL MUST include a
 * predicate filtering by `org_id = SecurityContext.organizationId`.
 *
 * We don't need a live Postgres for this — drizzle-cube's
 * `SemanticLayerCompiler.generateSQL()` returns the rendered SQL string
 * without executing it. We assert the WHERE clause is present and the
 * parameter list contains the supplied orgId.
 */
describe("agent_runs cube — org-scoped SQL predicate", () => {
  // Minimal in-test stand-in for the host's agent_runs Drizzle table.
  const fakeAgentRuns = pgTable("agent_runs", {
    id: text("id").primaryKey(),
    templateId: text("template_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    orgId: text("org_id").notNull(),
    runBy: text("run_by"),
  });

  // Stand-in for agent_templates. The cube LEFT-JOINs onto it so the
  // `agent_name` dimension can resolve to a human name.
  const fakeAgentTemplates = pgTable("agent_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  });

  it("generates SQL with org_id predicate bound to the SecurityContext", async () => {
    // No live DB — pass an unused Pool stand-in. generateSQL doesn't connect.
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
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
      },
    });
    layer.registerCube(cube.dcCube);

    const result = await layer.generateSQL(
      "agent_runs",
      {
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.status"],
      },
      { organizationId: "org_acme", userId: "u1" },
    );

    // `result` is { sql: string; params?: any[] } per drizzle-cube's d.ts.
    // The cube's WHERE clause is `org_id = $orgId OR run_by = $userId`
    // so both "owns" and "can access" branches are present; both column
    // names appear in the generated SQL, and both params are bound.
    expect(result.sql).toMatch(/org_id/);
    expect(result.sql).toMatch(/run_by/);
    expect(result.params ?? []).toContain("org_acme");
    expect(result.params ?? []).toContain("u1");
  });

  it("throws a clear error when SecurityContext.organizationId is missing", async () => {
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
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
      },
    });
    layer.registerCube(cube.dcCube);

    await expect(
      layer.generateSQL(
        "agent_runs",
        { measures: ["agent_runs.count"] },
        // Deliberately missing organizationId
        { userId: "u1" },
      ),
    ).rejects.toThrow(/SecurityContext\.organizationId/);

    // Missing userId also throws because it is required for the cube's
    // "owns" branch of the access predicate.
    await expect(
      layer.generateSQL(
        "agent_runs",
        { measures: ["agent_runs.count"] },
        { organizationId: "org_acme" },
      ),
    ).rejects.toThrow(/SecurityContext\.userId/);
  });

  // Multi-org membership widens the predicate to `org_id IN
  // (...accessibleOrgIds)`. When `accessibleOrgIds` is absent, the cube
  // falls back to `[organizationId]` so the active org remains the boundary.
  it("generates IN-list predicate when accessibleOrgIds has multiple orgs", async () => {
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
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
      },
    });
    layer.registerCube(cube.dcCube);

    const result = await layer.generateSQL(
      "agent_runs",
      {
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.status"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        accessibleOrgIds: ["org_acme", "org_beta", "org_gamma"],
      },
    );

    // SQL must include all three orgIds bound; not just the active one.
    // drizzle's `inArray` renders as `org_id in ($a, $b, $c)`; assert
    // each org id appears in the params list.
    expect(result.sql).toMatch(/org_id/);
    expect(result.sql).toMatch(/run_by/);
    expect(result.params ?? []).toContain("org_acme");
    expect(result.params ?? []).toContain("org_beta");
    expect(result.params ?? []).toContain("org_gamma");
    expect(result.params ?? []).toContain("u1");
  });

  it("falls back to [organizationId] when accessibleOrgIds is missing/empty", async () => {
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
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
      },
    });
    layer.registerCube(cube.dcCube);

    // No accessibleOrgIds — fall back to the active org only.
    const result = await layer.generateSQL(
      "agent_runs",
      { measures: ["agent_runs.count"] },
      { organizationId: "org_acme", userId: "u1" },
    );

    expect(result.params ?? []).toContain("org_acme");
    expect(result.params ?? []).toContain("u1");
    // No other org leaks through.
    expect((result.params ?? []).filter((p: unknown) => typeof p === "string" && p.startsWith("org_")).length).toBe(1);
  });
});
