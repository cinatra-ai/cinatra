/**
 * Source-text conformance for the consolidated /artifacts surface findings
 * (cinatra#1431). The repo runs vitest in a node environment without
 * @testing-library/react, so server-component wiring is pinned via source
 * assertions (the established repo pattern — see nav-modal-wiring.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("§V finding (b) — Approve writes the REAL org-scoped approval record, not a status flip", () => {
  const MODE = read("src/components/artifacts/types-approvals-mode.tsx");
  const ACTION = read("src/components/artifacts/types-approvals-approve-action.ts");

  it("the dynamic register reads the landed approval-record review rows (#1433)", () => {
    expect(MODE).toMatch(/listDynamicTypeVisibilityReviewRows/);
    expect(MODE).toMatch(/approvalAwaitsDecision/);
  });

  it("it no longer flips dynamic-type status via approve/archiveDynamicObjectTypeAction", () => {
    expect(MODE).not.toMatch(/approveDynamicObjectTypeAction/);
    expect(MODE).not.toMatch(/archiveDynamicObjectTypeAction/);
  });

  it("Approved rows read as carrying the approval record (honest render)", () => {
    expect(MODE).toMatch(/approval record set/);
    expect(MODE).toMatch(/not yet artifact-visible/);
  });

  it("the Approve server action calls the real approval ladder + admin-gates", () => {
    expect(ACTION).toMatch(/approveDynamicTypeArtifactVisibility/);
    expect(ACTION).toMatch(/isPlatformAdmin/);
    expect(ACTION).not.toMatch(/approveDynamicObjectType\b/);
    // Finding (c): revalidate the live surface, never the retired /data route.
    expect(ACTION).toMatch(/revalidatePath\("\/artifacts"\)/);
  });
});

describe("§V finding (c) — the dynamic-type lifecycle actions revalidate the live surface", () => {
  const ACTIONS = read("packages/objects/src/screens/object-type-actions.ts");
  it("revalidatePath targets /artifacts, never the retired /data/types", () => {
    expect(ACTIONS).not.toMatch(/revalidatePath\("\/data\/types"\)/);
    expect(ACTIONS.match(/revalidatePath\("\/artifacts"\)/g)?.length).toBe(2);
  });
});

describe("§II claimed-vs-plain rows dispatch to distinct chips", () => {
  const LIB = read("src/components/artifacts/library-mode.tsx");
  it("an extension identity renders the indigo claiming-extension chip; the floor/plain renders the Default artifact chip", () => {
    expect(LIB).toMatch(/identity\.kind === "extension"/);
    expect(LIB).toMatch(/extensionDisplayName\(identity\.extension\)/);
    expect(LIB).toMatch(/Default artifact/);
  });
});

describe("merge-proposals relocation is admin-gated (defense-in-depth)", () => {
  const DETAIL = read("src/app/artifacts/merge-proposals/[proposalId]/page.tsx");
  const ACTIONS = read("src/app/artifacts/merge-proposals/[proposalId]/actions.ts");
  it("the detail page 404s for a non-admin before rendering", () => {
    expect(DETAIL).toMatch(/if \(!isPlatformAdmin\(session\)\) notFound\(\)/);
  });
  it("both server actions refuse a non-admin (fail-closed) atop the per-object object.update authz", () => {
    expect(ACTIONS.match(/if \(!isPlatformAdmin\(session\)\)/g)?.length).toBe(2);
    expect(ACTIONS).toMatch(/enforceResourceAccess/);
  });
});
