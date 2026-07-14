/**
 * Source-text conformance for the consolidated /artifacts surface findings
 * (cinatra#1431). The repo runs vitest in a node environment without
 * @testing-library/react, so server-component wiring is pinned via source
 * assertions (the established repo pattern — see nav-modal-wiring.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
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

  it("the artifact-visibility approve is the record-writing button, not a status flip", () => {
    // The ACTIVE-type visibility approval routes through the record-writing
    // client button; the status-flip lifecycle actions are reserved for the
    // separate proposed-type feed (a distinct axis, asserted in the §V feed
    // relocation suite below). The visibility action must never be a status
    // flip — that invariant is pinned on the ACTION file further down.
    expect(MODE).toMatch(/TypesApprovalsApproveButton/);
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

describe("§V — the proposed-type approval feed relocated under Types & approvals (issue AC: /data/types incl. proposed feed relocates)", () => {
  const MODE = read("src/components/artifacts/types-approvals-mode.tsx");
  const INDEX = read("packages/objects/src/index.ts");
  const SCREENS = "packages/objects/src/screens";

  it("Types mode renders proposed dynamic types with lifecycle promote + archive (the former /data/types feed)", () => {
    expect(MODE).toMatch(/readAllDynamicObjectTypes/);
    expect(MODE).toMatch(/status === "proposed"/);
    expect(MODE).toMatch(/approveDynamicObjectTypeAction/);
    expect(MODE).toMatch(/archiveDynamicObjectTypeAction/);
    // The feed carries its own conformance-addressable container.
    expect(MODE).toMatch(/artifacts-proposed-types/);
  });

  it("Archive requires a confirmation dialog — no one-click destructive archive (there is no in-app un-archive)", () => {
    // Codex review: archiving is irreversible in-app (recovery needs a DB edit),
    // so it must go through the confirmation button, never a bare submit form.
    const BTN = read("src/components/artifacts/archive-type-button.tsx");
    expect(MODE).toMatch(/ArchiveTypeButton/);
    expect(MODE).not.toMatch(/action=\{archiveDynamicObjectTypeAction\.bind/);
    expect(BTN).toMatch(/AlertDialog/);
    expect(BTN).toMatch(/no in-app un-archive/);
  });

  it("the superseded /data screens are deleted — no orphaned dead code (§VII completion)", () => {
    expect(existsSync(path.join(ROOT, SCREENS, "object-types-screen.tsx"))).toBe(false);
    expect(existsSync(path.join(ROOT, SCREENS, "objects-browser.tsx"))).toBe(false);
    expect(existsSync(path.join(ROOT, SCREENS, "object-detail-page.tsx"))).toBe(false);
    expect(INDEX).not.toMatch(/ObjectTypesScreen/);
    expect(INDEX).not.toMatch(/ObjectsBrowserScreen/);
    expect(INDEX).not.toMatch(/ObjectDetailPage/);
    // The lifecycle actions the Types mode now drives are still exported.
    expect(INDEX).toMatch(/approveDynamicObjectTypeAction/);
    expect(INDEX).toMatch(/archiveDynamicObjectTypeAction/);
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

describe("§VI undo deep-link preserves the change-set target (no static list dump)", () => {
  const TOAST = read("src/components/data-safety/undo-toast.tsx");
  const PAGE = read("src/app/artifacts/page.tsx");
  const UNDO = read("src/components/artifacts/undo-mode.tsx");

  it("undoDeepLink carries the change-set id in openRestore (url-encoded), not a bare /artifacts?mode=undo", () => {
    expect(TOAST).toMatch(/mode=undo&openRestore=\$\{encodeURIComponent\(changeSetId\)\}/);
  });

  it("the surface page threads openRestore through to UndoMode", () => {
    expect(PAGE).toMatch(/openRestore\?: string/);
    expect(PAGE).toMatch(/openRestore=\{sp\.openRestore\}/);
  });

  it("UndoMode auto-opens ONLY the matching, restorable change-set's modal", () => {
    expect(UNDO).toMatch(/openRestore\?: string/);
    expect(UNDO).toMatch(/defaultOpen=\{openRestore === r\.id && r\.restorable\}/);
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
