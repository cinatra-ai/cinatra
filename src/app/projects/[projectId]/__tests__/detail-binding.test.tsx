import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");

// Detail page binding contract.
// Project is NEVER an ownership tier; the detail page therefore must NOT
// render a ratchet stepper, and it surfaces the archived status.
//
// RE-POINTED by cinatra#2807 fix leg 3. The landing IS the Dashboards tab, and
// the ratified drawing's Dashboards-tab section draws neither an ownership chip
// nor a counts card there; both were rendered by the Overview card of the
// dashboard canvas the third proof round graded as unspecified elements. The
// counts read went with that card — recorded as a judgment call on the pull
// request, since the drawing gives those numbers no home on this tab.

describe("/projects/[projectId] detail page DB binding", () => {
  it("imports the detail-page wiring (notFound, drizzle, projects, auth)", () => {
    expect(SOURCE).toMatch(/from\s+"next\/navigation"/);
    expect(SOURCE).toMatch(/notFound/);
    expect(SOURCE).toMatch(/from\s+"drizzle-orm"/);
    expect(SOURCE).toMatch(/\beq\b/);
    expect(SOURCE).toMatch(/\bsql\b/);
    expect(SOURCE).toMatch(/from\s+"@\/lib\/projects-store"/);
    expect(SOURCE).toMatch(/projectsDb/);
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

  it("renders NO ownership chip — the Dashboards tab draws no header chip", () => {
    // The chip and its owner-level narrowing lived only to feed it; ownership
    // still answers on the project's Settings pane and on a dashboard's own
    // surface, which `scope-badge-mounts-1905` still pins.
    expect(SOURCE).not.toContain("<ScopeBadge");
    expect(SOURCE).not.toContain("assertOwnerLevel");
  });

  it("removes the ratchet stepper UI", () => {
    // Ratchet steps are not part of the project detail page; the page must
    // not declare `RATCHET_STEPS` or iterate them in an <ol>.
    expect(SOURCE).not.toMatch(/RATCHET_STEPS/);
    expect(SOURCE).not.toMatch(/ratchet is irreversible/i);
    expect(SOURCE).not.toMatch(/Promote to next level/);
  });

  it("reads no sealed-room counts here — they had no drawn home on this tab", () => {
    // The counts existed for the Overview card of the dashboard canvas, which
    // this tab no longer draws. The retired chat_threads table stays retired
    // either way (cinatra#1037).
    expect(SOURCE).not.toMatch(/"agent_runs"/);
    expect(SOURCE).not.toMatch(/"assistant_threads"/);
    expect(SOURCE).not.toMatch(/"chat_threads"/);
  });

  it("reads archived_at and surfaces it", () => {
    expect(SOURCE).toMatch(/archived_at/);
    expect(SOURCE).toMatch(/isArchived/);
  });
});
