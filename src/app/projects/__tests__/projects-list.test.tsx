import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as ProjectsListMod from "@/app/projects/page";

const SOURCE = readFileSync("src/app/projects/page.tsx", "utf-8");

// `/projects` is now a Data-Cube dashboard. The legacy custom shadcn-table
// page (inline drizzle union + ScopeBadge cells + archive lifecycle controls)
// was retired wholesale per the milestone's one-shot migration policy; the
// dashboard reads the same project-grant visibility surface via the projects
// cube. The page module is a thin re-export of `ProjectsDashboardPage`.

describe("/projects list page", () => {
  it("exports a default async function", () => {
    expect(typeof ProjectsListMod.default).toBe("function");
  });

  it("re-exports ProjectsDashboardPage as default from @cinatra-ai/dashboards/screens", () => {
    expect(SOURCE).toMatch(/from\s+"@cinatra-ai\/dashboards\/screens"/);
    expect(SOURCE).toMatch(/export\s+\{\s*ProjectsDashboardPage as default\s*\}/);
  });

  it("declares page metadata", () => {
    expect(SOURCE).toMatch(/export const metadata/);
    expect(SOURCE).toMatch(/title:\s*"Projects"/);
  });

  it("does NOT re-implement the retired inline drizzle/table surface", () => {
    // The legacy page resolved grants inline and rendered its own table.
    // The dashboard owns all of that now; the page module must stay a
    // thin binding so the two surfaces don't drift.
    expect(SOURCE).not.toMatch(/from\s+"@\/lib\/projects-store"/);
    expect(SOURCE).not.toMatch(/from\s+"drizzle-orm"/);
    expect(SOURCE).not.toMatch(/readProjectGrantsForUser/);
    expect(SOURCE).not.toMatch(/from\s+"@\/components\/scope-badge"/);
  });

  it("does not use the disabled-tooltip create-project pattern", () => {
    expect(SOURCE).not.toMatch(/TooltipProvider/);
    expect(SOURCE).not.toMatch(/TooltipTrigger/);
    expect(SOURCE).not.toMatch(/disabled>Create project</);
  });

  it("does NOT render a ratchet-promotion stepper", () => {
    // Guards against any future regression that re-introduces a "promote"
    // affordance on the projects surface.
    expect(SOURCE).not.toMatch(/Promote to next level/);
  });
});
