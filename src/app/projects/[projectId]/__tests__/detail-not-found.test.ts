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

  it("performs the access check AFTER the existence check in BOTH functions (no extra DB queries on missing rows)", () => {
    // generateMetadata (cinatra#1737) repeats the read gate for the tab
    // title, so the ordering contract now holds per-function: each
    // enforceResourceAccess call must be preceded, within its own function,
    // by that function's existence guard.
    const metadataStart = SOURCE.indexOf("export async function generateMetadata");
    const pageStart = SOURCE.indexOf("export default async function");
    expect(metadataStart).toBeGreaterThan(-1);
    expect(pageStart).toBeGreaterThan(metadataStart);
    const metadataSrc = SOURCE.slice(metadataStart, pageStart);
    const pageSrc = SOURCE.slice(pageStart);

    // generateMetadata: early-return existence guard precedes its gate.
    const mExistenceIdx = metadataSrc.search(/if\s*\(\s*!\s*project\s*\)\s*return/);
    const mAccessIdx = metadataSrc.search(/enforceResourceAccess\s*\(/);
    expect(mExistenceIdx).toBeGreaterThan(-1);
    expect(mAccessIdx).toBeGreaterThan(mExistenceIdx);

    // Page component: notFound() existence guard precedes its gate.
    const pExistenceIdx = pageSrc.search(/if\s*\(\s*!\s*project\s*\)\s*notFound\(\)/);
    const pAccessIdx = pageSrc.search(/enforceResourceAccess\s*\(/);
    expect(pExistenceIdx).toBeGreaterThan(-1);
    expect(pAccessIdx).toBeGreaterThan(pExistenceIdx);
  });
});
