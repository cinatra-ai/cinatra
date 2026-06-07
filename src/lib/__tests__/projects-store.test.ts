import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { projects, projectsDb, projectsPool, type ProjectRecord, type NewProjectRecord } from "@/lib/projects-store";

const SOURCE = readFileSync("src/lib/projects-store.ts", "utf-8");

describe("projects-store typed Drizzle declaration", () => {
  it("exports `projects` table object and a `projectsDb` Drizzle client", () => {
    expect(projects).toBeDefined();
    expect(projectsDb).toBeDefined();
    expect(projectsPool).toBeDefined();
  });

  it("exposes the 7 column accessors on the projects table", () => {
    expect(projects.id).toBeDefined();
    expect(projects.name).toBeDefined();
    expect(projects.description).toBeDefined();
    expect(projects.ownerLevel).toBeDefined();
    expect(projects.ownerId).toBeDefined();
    expect(projects.visibility).toBeDefined();
    expect(projects.createdAt).toBeDefined();
  });

  it("ProjectRecord type accepts a row with the 7 expected fields", () => {
    // Compile-time assertion — does not execute against the DB.
    const sample: ProjectRecord = {
      id: "uuid",
      name: "n",
      description: null,
      ownerLevel: "user",
      ownerId: "u1",
      organizationId: null,
      visibility: "private",
      slug: "n",
      createdAt: new Date(),
    };
    const insert: NewProjectRecord = { id: "uuid", name: "n", ownerLevel: "user", ownerId: "u1", slug: "n" };
    expect(sample.id).toBe("uuid");
    expect(insert.name).toBe("n");
  });

  it("uses pgSchema() not pgTable() for the projects table", () => {
    expect(SOURCE).toContain("pgSchema(");
    expect(SOURCE).not.toMatch(/\bpgTable\(/);
  });

  it("caches Pool on globalThis and attaches an idempotent error listener", () => {
    expect(SOURCE).toContain("__cinatraProjectsPool");
    expect(SOURCE).toContain("listenerCount(\"error\")");
    expect(SOURCE).toContain("on(\"error\"");
  });
});
