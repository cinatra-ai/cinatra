import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");

// Detail page preserves a 404-hide + read-gate contract.
//
// The read gate is the CANONICAL sealed-room project grant (cinatra#1898 /
// #2064): the caller must hold a resolved `project_access` grant (owned ∪
// accessed) for THIS project, checked via `actorHoldsProjectGrant` against the
// `getActorContext`/`requireActorContext` `projectGrants` axis
// (`readProjectGrantsForUser`). This suite asserts that shape and prevents
// regressing to (a) bespoke IDOR SQL against `public."teamMember"` /
// `public.member`, OR (b) the kernel `can(project.read)` path, whose `member`
// role grants blanket org-wide read and would defeat the sealed room.
//
// NOTE: this is a SOURCE-SHAPE lock only. The BEHAVIORAL proof — a granted
// non-owner reading, and a non-grantee denied — lives in the real-store
// integration suite `project-read-gate.integration.test.ts`.

describe("/projects/[projectId] notFound + read gate", () => {
  it("calls notFound() at least twice — missing record AND access denied", () => {
    const matches = SOURCE.match(/notFound\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("gates on the canonical sealed-room project grant (actorHoldsProjectGrant)", () => {
    expect(SOURCE).toMatch(/actorHoldsProjectGrant/);
    expect(SOURCE).toMatch(/from\s+"@\/lib\/authz\/project-read-gate"/);
  });

  it("resolves the canonical actor (grants populated) — not the grant-less primitive", () => {
    expect(SOURCE).toMatch(/requireActorContext/);
    expect(SOURCE).toMatch(/getActorContext/);
    // The grant-less session primitive must NOT gate reads here.
    expect(SOURCE).not.toMatch(/actorFromSession/);
    // And the kernel can()-based generic gate (member → blanket project.read)
    // must not be the read gate on this surface.
    expect(SOURCE).not.toMatch(/enforceResourceAccess/);
  });

  it("performs the access check AFTER the existence check in BOTH functions (no extra DB queries on missing rows)", () => {
    // generateMetadata (cinatra#1737) repeats the read gate for the tab
    // title, so the ordering contract holds per-function: each
    // actorHoldsProjectGrant gate must be preceded, within its own function,
    // by that function's existence guard.
    const metadataStart = SOURCE.indexOf("export async function generateMetadata");
    const pageStart = SOURCE.indexOf("export default async function");
    expect(metadataStart).toBeGreaterThan(-1);
    expect(pageStart).toBeGreaterThan(metadataStart);
    const metadataSrc = SOURCE.slice(metadataStart, pageStart);
    const pageSrc = SOURCE.slice(pageStart);

    // generateMetadata: early-return existence guard precedes its gate.
    const mExistenceIdx = metadataSrc.search(/if\s*\(\s*!\s*project\s*\)\s*return/);
    const mAccessIdx = metadataSrc.search(/actorHoldsProjectGrant\s*\(/);
    expect(mExistenceIdx).toBeGreaterThan(-1);
    expect(mAccessIdx).toBeGreaterThan(mExistenceIdx);

    // Page component: notFound() existence guard precedes its gate.
    const pExistenceIdx = pageSrc.search(/if\s*\(\s*!\s*project\s*\)\s*notFound\(\)/);
    const pAccessIdx = pageSrc.search(/actorHoldsProjectGrant\s*\(/);
    expect(pExistenceIdx).toBeGreaterThan(-1);
    expect(pAccessIdx).toBeGreaterThan(pExistenceIdx);
  });
});
