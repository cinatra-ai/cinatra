import { describe, it, expect } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

describe("projects schema migration", () => {
  const queries = buildCreateStoreSchemaQueries("cinatra_test");
  const texts = queries.map((q) => q.text);

  it("includes a CREATE TABLE for cinatra_test.projects with all 7 columns", () => {
    const projectsTableSql = texts.find(
      (t) => t.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."projects"'),
    );
    expect(projectsTableSql).toBeDefined();
    expect(projectsTableSql).toContain("id text PRIMARY KEY");
    expect(projectsTableSql).toContain("name text NOT NULL");
    expect(projectsTableSql).toContain("description text");
    expect(projectsTableSql).toContain("owner_level text NOT NULL");
    expect(projectsTableSql).toContain("owner_id text NOT NULL");
    expect(projectsTableSql).toContain("visibility text NOT NULL DEFAULT 'private'");
    expect(projectsTableSql).toContain("created_at timestamptz NOT NULL DEFAULT now()");
  });

  it("includes a CREATE INDEX for owner_level + owner_id", () => {
    const ownerIdx = texts.find((t) =>
      t.includes('CREATE INDEX IF NOT EXISTS projects_owner_idx ON "cinatra_test"."projects" (owner_level, owner_id)'),
    );
    expect(ownerIdx).toBeDefined();
  });

  it("includes a CREATE INDEX for created_at DESC", () => {
    const createdIdx = texts.find((t) =>
      t.includes('CREATE INDEX IF NOT EXISTS projects_created_at_idx ON "cinatra_test"."projects" (created_at DESC)'),
    );
    expect(createdIdx).toBeDefined();
  });

  it("appends the projects migration after the last agent_runs migration", () => {
    const lastAgentRunsIdx = texts.findLastIndex((t) =>
      t.includes('"agent_runs"') && t.includes("a2a_context_id"),
    );
    const projectsTableIdx = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."projects"'),
    );
    expect(lastAgentRunsIdx).toBeGreaterThan(-1);
    expect(projectsTableIdx).toBeGreaterThan(lastAgentRunsIdx);
  });
});
