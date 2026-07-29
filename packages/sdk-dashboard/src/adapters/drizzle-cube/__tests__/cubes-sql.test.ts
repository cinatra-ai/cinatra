/**
 * SQL-emission tests for the four cubes. Uses the same
 * `generateSQL` pattern as `agent-runs-sql.test.ts` (no live DB —
 * drizzle-cube's `SemanticLayerCompiler.generateSQL()` renders the SQL
 * without executing). Each test asserts the cube's `WHERE id IN (...)`
 * predicate references the right column AND that the per-cube visibility
 * id from `SecurityContext` shows up in the bound params.
 *
 * Failure modes guarded:
 *   - Missing `visibleProjectIds` etc. → cube emits `id IN ('-')` so zero
 *     rows leak (fail-closed). The agents cube takes a different path
 *     (membership-derived predicate), so this is an invariant.
 *   - SQL column emitted matches the descriptor's primary key column
 *     (id → cube WHERE clause).
 */
import { describe, expect, it } from "vitest";
import {
  pgSchema,
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDrizzleSemanticLayer } from "drizzle-cube/server";

import { createProjectsCube } from "../cubes/projects";
import { createTeamsCube } from "../cubes/teams";
import { createOrganizationsCube } from "../cubes/organizations";
import { createArtifactsCube } from "../cubes/artifacts";

const cinatraSchema = pgSchema("cinatra");

const fakeProjects = cinatraSchema.table("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  organizationId: text("organization_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const fakeOrganizations = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
  archivedAt: timestamp("archivedAt", { withTimezone: true, mode: "date" }),
});

const fakeTeams = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organizationId: text("organizationId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

const fakeMembers = pgTable("member", {
  organizationId: text("organizationId").notNull(),
  userId: text("userId").notNull(),
  role: text("role"),
});

const fakeObjects = cinatraSchema.table("objects", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  orgId: text("org_id"),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

const stubLayer = () =>
  createDrizzleSemanticLayer({
    drizzle: drizzle({} as never) as never,
    schema: {
      fakeProjects,
      fakeOrganizations,
      fakeTeams,
      fakeMembers,
      fakeObjects,
    },
  });

describe("projects cube — visibility predicate", () => {
  it("emits WHERE id IN (...visibleProjectIds) AND archived_at IS NULL", async () => {
    const layer = stubLayer();
    const cube = createProjectsCube({
      tableRef: fakeProjects,
      columns: {
        id: fakeProjects.id,
        name: fakeProjects.name,
        slug: fakeProjects.slug,
        organizationId: fakeProjects.organizationId,
        archivedAt: fakeProjects.archivedAt,
        createdAt: fakeProjects.createdAt,
      },
      organizationsTableRef: fakeOrganizations,
      organizationColumns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "projects",
      {
        measures: ["projects.count"],
        dimensions: ["projects.name"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        visibleProjectIds: ["p1", "p2"],
      },
    );
    expect(sql).toMatch(/archived_at/);
    expect(params ?? []).toEqual(expect.arrayContaining(["p1", "p2"]));
  });

  it("fails closed when visibleProjectIds is missing", async () => {
    const layer = stubLayer();
    const cube = createProjectsCube({
      tableRef: fakeProjects,
      columns: {
        id: fakeProjects.id,
        name: fakeProjects.name,
        slug: fakeProjects.slug,
        organizationId: fakeProjects.organizationId,
        archivedAt: fakeProjects.archivedAt,
        createdAt: fakeProjects.createdAt,
      },
      organizationsTableRef: fakeOrganizations,
      organizationColumns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "projects",
      {
        measures: ["projects.count"],
        dimensions: ["projects.name"],
      },
      { organizationId: "org_acme", userId: "u1" },
    );
    // No sentinel id flows through — the cube now emits `WHERE false`
    // when the visibility list is missing. The SQL should literally
    // contain the keyword `false` and the visibility list should not be
    // bound as a parameter.
    expect(sql).toMatch(/\bfalse\b/i);
    expect(params ?? []).not.toContain("-");
  });
});

describe("teams cube — visibility predicate", () => {
  it("emits WHERE id IN (...visibleTeamIds) with the supplied ids in params", async () => {
    const layer = stubLayer();
    const cube = createTeamsCube({
      tableRef: fakeTeams,
      columns: {
        id: fakeTeams.id,
        name: fakeTeams.name,
        organizationId: fakeTeams.organizationId,
        createdAt: fakeTeams.createdAt,
      },
      organizationsTableRef: fakeOrganizations,
      organizationColumns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
      },
    });
    layer.registerCube(cube.dcCube);
    const { params } = await layer.generateSQL(
      "teams",
      {
        measures: ["teams.count"],
        dimensions: ["teams.name"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        visibleTeamIds: ["t1", "t2"],
      },
    );
    expect(params ?? []).toEqual(expect.arrayContaining(["t1", "t2"]));
  });

  it("fails closed when visibleTeamIds is missing", async () => {
    const layer = stubLayer();
    const cube = createTeamsCube({
      tableRef: fakeTeams,
      columns: {
        id: fakeTeams.id,
        name: fakeTeams.name,
        organizationId: fakeTeams.organizationId,
        createdAt: fakeTeams.createdAt,
      },
      organizationsTableRef: fakeOrganizations,
      organizationColumns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "teams",
      {
        measures: ["teams.count"],
        dimensions: ["teams.name"],
      },
      { organizationId: "org_acme", userId: "u1" },
    );
    expect(sql).toMatch(/\bfalse\b/i);
    expect(params ?? []).not.toContain("-");
  });

  it('member_count emits a correlated subquery over public."teamMember"', async () => {
    const layer = stubLayer();
    const cube = createTeamsCube({
      tableRef: fakeTeams,
      columns: {
        id: fakeTeams.id,
        name: fakeTeams.name,
        organizationId: fakeTeams.organizationId,
        createdAt: fakeTeams.createdAt,
      },
      organizationsTableRef: fakeOrganizations,
      organizationColumns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql } = await layer.generateSQL(
      "teams",
      {
        measures: ["teams.member_count"],
        dimensions: ["teams.name"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        visibleTeamIds: ["t1", "t2"],
      },
    );
    expect(sql).toMatch(/teamMember/);
    expect(sql).toMatch(/count\(\*\)/i);
  });

  it("AND-intersects a per-entity equals filter WITH the visibility predicate (EDD security invariant)", async () => {
    // The per-entity detail dashboards scope to one team via an `equals` filter
    // on teams.id. That filter must be an ADDITIONAL predicate on top of the
    // cube's `WHERE id IN (visibleTeamIds)` security predicate — never a
    // replacement. Pin the defense-in-depth so a future drizzle-cube bump that
    // regressed the AND-combination would fail here.
    const mk = () => {
      const layer = stubLayer();
      const cube = createTeamsCube({
        tableRef: fakeTeams,
        columns: { id: fakeTeams.id, name: fakeTeams.name, organizationId: fakeTeams.organizationId, createdAt: fakeTeams.createdAt },
        organizationsTableRef: fakeOrganizations,
        organizationColumns: { id: fakeOrganizations.id, name: fakeOrganizations.name },
      });
      layer.registerCube(cube.dcCube);
      return layer;
    };
    const ctx = { organizationId: "org_acme", userId: "u1", visibleTeamIds: ["t1", "t2"] };
    const base = await mk().generateSQL("teams", { dimensions: ["teams.name"] }, ctx);
    const scoped = await mk().generateSQL(
      "teams",
      { dimensions: ["teams.name"], filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }] },
      ctx,
    );
    // Visibility predicate is present in BOTH (the filter never replaces it).
    expect(base.params ?? []).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(scoped.params ?? []).toEqual(expect.arrayContaining(["t1", "t2"]));
    // The equals filter ADDS a bound predicate on top of the visibility IN-list.
    expect((scoped.params ?? []).length).toBeGreaterThan((base.params ?? []).length);
  });
});

describe("organizations cube — accessibleOrgIds predicate", () => {
  it("emits WHERE id IN (...accessibleOrgIds) and LEFT JOIN includes actor userId", async () => {
    const layer = stubLayer();
    const cube = createOrganizationsCube({
      tableRef: fakeOrganizations,
      columns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
        slug: fakeOrganizations.slug,
        createdAt: fakeOrganizations.createdAt,
        archivedAt: fakeOrganizations.archivedAt,
      },
      membersTableRef: fakeMembers,
      memberColumns: {
        organizationId: fakeMembers.organizationId,
        userId: fakeMembers.userId,
        role: fakeMembers.role,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "organizations",
      {
        measures: ["organizations.count"],
        dimensions: ["organizations.name"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        accessibleOrgIds: ["org_acme", "org_b"],
      },
    );
    expect(sql).toMatch(/left\s+join/i);
    expect(params ?? []).toEqual(expect.arrayContaining(["org_acme", "org_b", "u1"]));
  });

  it("fails closed when accessibleOrgIds is missing", async () => {
    const layer = stubLayer();
    const cube = createOrganizationsCube({
      tableRef: fakeOrganizations,
      columns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
        slug: fakeOrganizations.slug,
        createdAt: fakeOrganizations.createdAt,
        archivedAt: fakeOrganizations.archivedAt,
      },
      membersTableRef: fakeMembers,
      memberColumns: {
        organizationId: fakeMembers.organizationId,
        userId: fakeMembers.userId,
        role: fakeMembers.role,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "organizations",
      {
        measures: ["organizations.count"],
        dimensions: ["organizations.name"],
      },
      { organizationId: "org_acme", userId: "u1" },
    );
    expect(sql).toMatch(/\bfalse\b/i);
    expect(params ?? []).not.toContain("-");
  });

  // cinatra#1942 (Decision 6) — the lifecycle_status / archived_at dimensions.
  const mkOrganizationsCube = () => {
    const layer = stubLayer();
    const cube = createOrganizationsCube({
      tableRef: fakeOrganizations,
      columns: {
        id: fakeOrganizations.id,
        name: fakeOrganizations.name,
        slug: fakeOrganizations.slug,
        createdAt: fakeOrganizations.createdAt,
        archivedAt: fakeOrganizations.archivedAt,
      },
      membersTableRef: fakeMembers,
      memberColumns: {
        organizationId: fakeMembers.organizationId,
        userId: fakeMembers.userId,
        role: fakeMembers.role,
      },
    });
    layer.registerCube(cube.dcCube);
    return layer;
  };
  const ctx = { organizationId: "org_acme", userId: "u1", accessibleOrgIds: ["org_acme", "org_b"] };

  it("lifecycle_status emits a CASE WHEN archivedAt IS NULL THEN 'active' ELSE 'archived' END expression", async () => {
    const { sql } = await mkOrganizationsCube().generateSQL(
      "organizations",
      { measures: ["organizations.count"], dimensions: ["organizations.lifecycle_status"] },
      ctx,
    );
    expect(sql).toMatch(/case\s+when/i);
    expect(sql).toMatch(/archivedAt/);
    expect(sql).toMatch(/'active'/);
    expect(sql).toMatch(/'archived'/);
  });

  it("archived_at emits the raw archivedAt column (the predicate-shaped sibling dimension)", async () => {
    const { sql } = await mkOrganizationsCube().generateSQL(
      "organizations",
      { measures: ["organizations.count"], dimensions: ["organizations.archived_at"] },
      ctx,
    );
    expect(sql).toMatch(/archivedAt/);
    // Not the computed CASE expression — a bare column reference.
    expect(sql).not.toMatch(/case\s+when/i);
  });

  it("AND-intersects a lifecycle_status equals filter WITH the accessibleOrgIds predicate (EDD security invariant)", async () => {
    // Mirrors the teams-cube pin above: the default-active seed filter (and the
    // fixed Archived section's flipped filter) must be an ADDITIONAL predicate
    // on top of the cube's `WHERE id IN (accessibleOrgIds)` security predicate
    // — never a replacement.
    const base = await mkOrganizationsCube().generateSQL(
      "organizations",
      { dimensions: ["organizations.name"] },
      ctx,
    );
    const scoped = await mkOrganizationsCube().generateSQL(
      "organizations",
      {
        dimensions: ["organizations.name"],
        filters: [{ member: "organizations.lifecycle_status", operator: "equals", values: ["active"] }],
      },
      ctx,
    );
    expect(base.params ?? []).toEqual(expect.arrayContaining(["org_acme", "org_b"]));
    expect(scoped.params ?? []).toEqual(expect.arrayContaining(["org_acme", "org_b"]));
    expect((scoped.params ?? []).length).toBeGreaterThan((base.params ?? []).length);
    // Stronger than a param-count check alone (codex r0 nit): assert the
    // predicates are actually CONJOINED with AND, not silently OR'd or
    // replaced — count `AND` occurrences rather than just inferring it from
    // param growth.
    const andCount = (s: string) => (s.match(/\bAND\b/gi) ?? []).length;
    expect(andCount(scoped.sql)).toBeGreaterThan(andCount(base.sql));
    expect(scoped.sql).toMatch(/case\s+when/i);
  });
});

describe("artifacts cube — visibility predicate", () => {
  it("emits WHERE id IN (...visibleArtifactIds) AND org_id = ctx AND deleted_at IS NULL", async () => {
    const layer = stubLayer();
    const cube = createArtifactsCube({
      tableRef: fakeObjects,
      columns: {
        id: fakeObjects.id,
        type: fakeObjects.type,
        orgId: fakeObjects.orgId,
        data: fakeObjects.data,
        createdAt: fakeObjects.createdAt,
        deletedAt: fakeObjects.deletedAt,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "artifacts",
      {
        measures: ["artifacts.count"],
        dimensions: ["artifacts.name"],
      },
      {
        organizationId: "org_acme",
        userId: "u1",
        visibleArtifactIds: ["a1", "a2"],
      },
    );
    expect(sql).toMatch(/deleted_at/);
    expect(params ?? []).toEqual(expect.arrayContaining(["a1", "a2", "org_acme"]));
  });

  it("fails closed when visibleArtifactIds is missing", async () => {
    const layer = stubLayer();
    const cube = createArtifactsCube({
      tableRef: fakeObjects,
      columns: {
        id: fakeObjects.id,
        type: fakeObjects.type,
        orgId: fakeObjects.orgId,
        data: fakeObjects.data,
        createdAt: fakeObjects.createdAt,
        deletedAt: fakeObjects.deletedAt,
      },
    });
    layer.registerCube(cube.dcCube);
    const { sql, params } = await layer.generateSQL(
      "artifacts",
      {
        measures: ["artifacts.count"],
        dimensions: ["artifacts.name"],
      },
      { organizationId: "org_acme", userId: "u1" },
    );
    expect(sql).toMatch(/\bfalse\b/i);
    expect(params ?? []).not.toContain("-");
  });
});
