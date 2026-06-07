import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");

// Detail page preserves a 404-hide + read-gate contract.
// Access checks must go through the canonical `enforceResourceAccess` kernel
// helper instead of bespoke IDOR SQL against `public."teamMember"` +
// `public.member`. This suite asserts the kernel-gated shape and prevents
// reintroducing inline authorization queries.

describe("/projects/[projectId] notFound + read gate", () => {
  it("calls notFound() at least twice — missing record AND access denied", () => {
    const matches = SOURCE.match(/notFound\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("uses enforceResourceAccess for the access check (canonical helper)", () => {
    expect(SOURCE).toMatch(/enforceResourceAccess/);
    expect(SOURCE).toMatch(/from\s+"@\/lib\/authz\/enforce-resource-access"/);
  });

  it("maps the helper's AuthzError to notFound() so existence is not leaked", () => {
    expect(SOURCE).toMatch(/AuthzError/);
    // The catch arm narrows on AuthzError → notFound().
    expect(SOURCE).toMatch(/instanceof\s+AuthzError/);
  });

  it("loads project_co_owners and forwards the user-id set into the resource envelope", () => {
    expect(SOURCE).toMatch(/readProjectCoOwners/);
    expect(SOURCE).toMatch(/coOwnerUserIds:\s*coOwners\.map/);
  });

  it("performs the access check AFTER the existence check (no extra DB queries on missing rows)", () => {
    const existenceIdx = SOURCE.search(/if\s*\(\s*!\s*project\s*\)\s*notFound\(\)/);
    const accessCheckIdx = SOURCE.search(/enforceResourceAccess\s*\(/);
    expect(existenceIdx).toBeGreaterThan(-1);
    expect(accessCheckIdx).toBeGreaterThan(existenceIdx);
  });
});
