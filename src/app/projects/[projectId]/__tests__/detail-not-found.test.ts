import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");
const READER = readFileSync("src/lib/scope-surface-entity-name.ts", "utf-8");

// Detail page preserves a 404-hide + read-gate contract.
//
// The read gate is the CANONICAL sealed-room project grant (cinatra#1898 /
// #2064): the caller must hold a resolved `project_access` grant (owned union
// accessed) for THIS project, checked via `actorHoldsProjectGrant` against the
// `getActorContext`/`requireActorContext` `projectGrants` axis
// (`readProjectGrantsForUser`). This suite asserts that shape and prevents
// regressing to (a) bespoke IDOR SQL against `public."teamMember"` /
// `public.member`, OR (b) the kernel `can(project.read)` path, whose `member`
// role grants blanket org-wide read and would defeat the sealed room.
//
// The gate now lives in TWO places, and this suite locks BOTH: the page
// component still gates its own render inline, while the gate-repeating
// `generateMetadata` (cinatra#1737) delegates to the single gated name reader
// `readScopeSurfaceEntityName` -> `readProjectName`
// (`src/lib/scope-surface-entity-name.ts`, cinatra#2807 per-scope surfaces S1),
// so the browser tab title and the page heading can never disagree about what
// the viewer may be told. Re-pointing the metadata half at that reader is what
// keeps the disclosure gated; deleting these assertions instead would drop the
// IDOR regression lock the file exists to hold.
//
// NOTE: this is a SOURCE-SHAPE lock only. The BEHAVIORAL proof — a granted
// non-owner reading, and a non-grantee denied — lives in the real-store
// integration suite `project-read-gate.integration.test.ts`.

/** The body of `name`, from its declaration up to the next top-level one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextIdx = rest.search(/\n(?:export )?(?:async )?function /);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

describe("/projects/[projectId] notFound + read gate", () => {
  it("calls notFound() at least twice — missing record AND access denied", () => {
    const matches = SOURCE.match(/notFound\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("gates on the canonical sealed-room project grant (actorHoldsProjectGrant)", () => {
    for (const src of [SOURCE, READER]) {
      expect(src).toMatch(/actorHoldsProjectGrant/);
      expect(src).toMatch(/from\s+"@\/lib\/authz\/project-read-gate"/);
    }
  });

  it("resolves the canonical actor (grants populated) — not the grant-less primitive", () => {
    expect(SOURCE).toMatch(/requireActorContext/);
    expect(READER).toMatch(/getActorContext/);
    // The grant-less session primitive must NOT gate reads on either half.
    for (const src of [SOURCE, READER]) {
      expect(src).not.toMatch(/actorFromSession/);
      // And the kernel can()-based generic gate (member -> blanket
      // project.read) must not be the read gate on this surface.
      expect(src).not.toMatch(/enforceResourceAccess/);
    }
  });

  it("routes the tab title through the SINGLE gated name reader — never an ungated read", () => {
    const metadataStart = SOURCE.indexOf("export async function generateMetadata");
    expect(metadataStart).toBeGreaterThan(-1);
    const metadataSrc = SOURCE.slice(
      metadataStart,
      SOURCE.indexOf("export default async function"),
    );
    expect(metadataSrc).toMatch(/readScopeSurfaceEntityName\s*\(/);
    // The metadata half must not reach the store itself: the gate and the read
    // stay in ONE place.
    expect(metadataSrc).not.toMatch(/projectsDb/);
    expect(SOURCE).toMatch(
      /readScopeSurfaceEntityName[\s\S]*?from\s+"@\/lib\/scope-surface-entity-name"/,
    );
  });

  it("performs the access check AFTER the existence check in BOTH gated reads (no extra DB queries on missing rows)", () => {
    // Page component: notFound() existence guard precedes its gate.
    const pageStart = SOURCE.indexOf("export default async function");
    expect(pageStart).toBeGreaterThan(-1);
    const pageSrc = SOURCE.slice(pageStart);
    const pExistenceIdx = pageSrc.search(/if\s*\(\s*!\s*project\s*\)\s*notFound\(\)/);
    const pAccessIdx = pageSrc.search(/actorHoldsProjectGrant\s*\(/);
    expect(pExistenceIdx).toBeGreaterThan(-1);
    expect(pAccessIdx).toBeGreaterThan(pExistenceIdx);

    // The gated name reader the tab title delegates to: early-return existence
    // guard precedes its gate, same ordering contract.
    const readerSrc = functionBody(READER, "readProjectName");
    const rExistenceIdx = readerSrc.search(/if\s*\(\s*!\s*project\s*\)\s*return/);
    const rAccessIdx = readerSrc.search(/actorHoldsProjectGrant\s*\(/);
    expect(rExistenceIdx).toBeGreaterThan(-1);
    expect(rAccessIdx).toBeGreaterThan(rExistenceIdx);
  });
});
