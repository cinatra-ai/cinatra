import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");

// Detail page binding contract.
// Project is NEVER an ownership tier; the detail page therefore must NOT
// render a ratchet stepper and MUST surface the sealed-room counts +
// archived status.

describe("/projects/[projectId] detail page DB binding", () => {
  it("imports the detail-page wiring (notFound, drizzle, projects, auth, ScopeBadge)", () => {
    expect(SOURCE).toMatch(/from\s+"next\/navigation"/);
    expect(SOURCE).toMatch(/notFound/);
    expect(SOURCE).toMatch(/from\s+"drizzle-orm"/);
    expect(SOURCE).toMatch(/\beq\b/);
    expect(SOURCE).toMatch(/\bsql\b/);
    expect(SOURCE).toMatch(/from\s+"@\/lib\/projects-store"/);
    expect(SOURCE).toMatch(/projectsDb/);
    expect(SOURCE).toMatch(/from\s+"@\/components\/scope-badge"/);
    expect(SOURCE).toMatch(/ScopeLevel/);
  });

  it("keeps hard-coded CURRENT_OWNERSHIP_LEVEL retired", () => {
    expect(SOURCE).not.toMatch(/CURRENT_OWNERSHIP_LEVEL/);
  });

  it("queries projectsDb.select().from(projects).where(eq(projects.id, …))", () => {
    // Tolerant to chained-call line breaks (Drizzle's fluent builder is often
    // multi-line for readability).
    expect(SOURCE).toMatch(/projectsDb[\s\S]*?\.select\(\)/);
    expect(SOURCE).toMatch(/\.from\(\s*projects\s*\)/);
    expect(SOURCE).toMatch(/eq\(\s*projects\.id/);
  });

  it("binds project.name to PageHeader title", () => {
    expect(SOURCE).toMatch(/<PageHeader[\s\S]*?title=\{[^}]*project\.name/);
  });

  it("renders <ScopeBadge level={ownerLevel}> from the runtime-narrowed value", () => {
    // The page narrows project.ownerLevel via assertOwnerLevel() into a
    // local `ownerLevel` const and passes that to the badge — no `as
    // ScopeLevel` cast on the JSX site.
    expect(SOURCE).toMatch(/<ScopeBadge[\s\S]*?level=\{ownerLevel\}/);
  });

  it("removes the ratchet stepper UI", () => {
    // Ratchet steps are not part of the project detail page; the page must
    // not declare `RATCHET_STEPS` or iterate them in an <ol>.
    expect(SOURCE).not.toMatch(/RATCHET_STEPS/);
    expect(SOURCE).not.toMatch(/ratchet is irreversible/i);
    expect(SOURCE).not.toMatch(/Promote to next level/);
  });

  it("queries the sealed-room counts (objects / agent_runs / chat_threads)", () => {
    // Sealed-room columns live on the same physical tables; the page reads
    // counts directly so they match what the list handlers expose through MCP.
    expect(SOURCE).toMatch(/"objects"/);
    expect(SOURCE).toMatch(/"agent_runs"/);
    expect(SOURCE).toMatch(/"chat_threads"/);
    expect(SOURCE).toMatch(/project_id\s*=\s*\$\{project\.id\}/);
  });

  it("reads archived_at and surfaces it", () => {
    expect(SOURCE).toMatch(/archived_at/);
    expect(SOURCE).toMatch(/isArchived/);
  });
});
