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
    title: text("title"),
    orgId: text("org_id").notNull(),
    runBy: text("run_by"),
  });

  // Stand-in for agent_templates. The cube LEFT-JOINs onto it so the
  // `agent_name` dimension can resolve to a human name and the
  // vendor/package_name dimensions can split the scoped package identity.
  const fakeAgentTemplates = pgTable("agent_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    packageName: text("package_name").notNull(),
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
        title: fakeAgentRuns.title,
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
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
        title: fakeAgentRuns.title,
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
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
        title: fakeAgentRuns.title,
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
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
        title: fakeAgentRuns.title,
        orgId: fakeAgentRuns.orgId,
        runBy: fakeAgentRuns.runBy,
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
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

  // cinatra#2448 — the per-run portlet query. Dimensioning on run_id keys
  // every row to ONE run (no per-agent collapsing); run_name reads the run
  // title with a template-name fallback; vendor/package_name split the
  // scoped package identity so the client can build the run href from row
  // data alone.
  it("supports the per-run dimensions (run_id, run_name, vendor, package_name)", async () => {
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
      },
      templatesTableRef: fakeAgentTemplates,
      templateColumns: {
        id: fakeAgentTemplates.id,
        name: fakeAgentTemplates.name,
        packageName: fakeAgentTemplates.packageName,
      },
    });
    layer.registerCube(cube.dcCube);

    // Descriptor exposes the per-run members.
    const dimIds = cube.descriptor.dimensions.map((d) => d.id);
    expect(dimIds).toEqual(
      expect.arrayContaining(["run_id", "run_name", "vendor", "package_name", "status", "created_at"]),
    );

    const result = await layer.generateSQL(
      "agent_runs",
      {
        dimensions: [
          "agent_runs.run_id",
          "agent_runs.run_name",
          "agent_runs.agent_name",
          "agent_runs.status",
          "agent_runs.created_at",
          "agent_runs.vendor",
          "agent_runs.package_name",
        ],
        order: { "agent_runs.created_at": "desc" },
        limit: 5,
      },
      { organizationId: "org_acme", userId: "u1" },
    );

    // run_name reads the run's own title (with fallback) — the query is
    // per-run, so the SQL must reference agent_runs.title...
    expect(result.sql).toMatch(/title/);
    // ...and the href coordinates come from the template's scoped package
    // identity.
    expect(result.sql).toMatch(/package_name/);
    // The access predicate is still enforced on the per-run shape.
    expect(result.sql).toMatch(/org_id/);
    expect(result.params ?? []).toContain("org_acme");
    // Newest-first + top-5 are part of the pinned per-run contract — the
    // portlet's "newest-first, limited to 5" acceptance criterion depends
    // on the compiler emitting them, so a regression dropping the sort or
    // the row cap must fail HERE. drizzle-cube orders by the aliased
    // output column and binds the LIMIT as the trailing parameter.
    expect(result.sql).toMatch(/order by\s+"agent_runs\.created_at" desc/i);
    expect(result.sql).toMatch(/limit\s+\$\d+\s*$/i);
    expect((result.params ?? []).at(-1)).toBe(5);
  });
});
