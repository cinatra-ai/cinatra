/**
 * Source-text conformance for the library-only `/artifacts` surface
 * (cinatra#1791, epic #1785, spec design@923fa0d8 `specs/app-artifacts.html`
 * §I/§II/§IV). `/artifacts` is the library and nothing else: the identity-gated
 * view dispatch (`?mode=`), its segmented control, and the refusal panel are
 * retired. The former administrator surfaces live on the
 * `/configuration/artifacts` console (#1786, verified in
 * `../console/__tests__/console-link-retargets.test.ts` +
 * `../../../app/artifacts/__tests__/data-retirement.test.ts`) and on the shared
 * artifact-review surface (#1795), and the targeted-restore entry affordances
 * deep-link to the console's nested restore route.
 *
 * The repo runs vitest in a node environment without @testing-library/react, so
 * server-component wiring is pinned via source assertions (the established repo
 * pattern — see nav-modal-wiring.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

describe("§I — /artifacts is the library, and nothing else (render→spec: no view toggle)", () => {
  const PAGE = read("src/app/artifacts/page.tsx");

  it("renders the library as the lone view", () => {
    expect(PAGE).toMatch(/import \{ LibraryMode \} from "@\/components\/artifacts\/library-mode"/);
    expect(PAGE).toMatch(/<LibraryMode\s/);
  });

  it("no view dispatch: neither the mode control nor the mode resolver is wired in", () => {
    expect(PAGE).not.toMatch(/ArtifactsModeControl/);
    expect(PAGE).not.toMatch(/artifacts-mode-control/);
    expect(PAGE).not.toMatch(/resolveRequestedArtifactsMode/);
    expect(PAGE).not.toMatch(/planArtifactsContent/);
    // No `?mode=` search param is read, so no legacy mode key survives.
    expect(PAGE).not.toMatch(/mode\?:\s*string/);
  });

  it("no former admin view body is dispatched from the library page", () => {
    expect(PAGE).not.toMatch(/RawObjectsMode/);
    expect(PAGE).not.toMatch(/TypesApprovalsMode/);
    expect(PAGE).not.toMatch(/UndoMode/);
    expect(PAGE).not.toMatch(/MergeProposalsMode/);
    expect(PAGE).not.toMatch(/ArtifactsNotAuthorizedPanel/);
    // The targeted-restore carve-out moved to the console's nested route
    // (`/configuration/artifacts/restore/[changeSetId]`), so the page no longer
    // loads or renders it.
    expect(PAGE).not.toMatch(/TargetedRestoreMode/);
    expect(PAGE).not.toMatch(/loadAuthorizedTargetedRestore/);
  });

  it("the library is served to every role (no admin gate on /artifacts)", () => {
    expect(PAGE).not.toMatch(/isPlatformAdmin/);
    expect(PAGE).not.toMatch(/requireAdminSession/);
    expect(PAGE).toMatch(/requireActorContext/);
  });
});

describe("§I — the identity-gated view machinery is retired outright", () => {
  it("the mode model, the segmented control, and the refusal panel are deleted", () => {
    expect(exists("src/components/artifacts/artifacts-modes.ts")).toBe(false);
    expect(exists("src/components/artifacts/artifacts-mode-control.tsx")).toBe(false);
    expect(exists("src/components/artifacts/not-authorized-panel.tsx")).toBe(false);
  });

  it("the mode-resolution unit test is removed with its machinery", () => {
    expect(exists("src/components/artifacts/__tests__/artifacts-modes.test.ts")).toBe(false);
  });
});

describe("§II — the library keeps its conformance anchor + claimed/plain chip dispatch", () => {
  const LIB = read("src/components/artifacts/library-mode.tsx");

  it("the library list carries the artifacts-library-list conformance id", () => {
    expect(LIB).toMatch(/data-conformance-id="artifacts-library-list"/);
  });

  it("an extension identity renders the claiming-extension chip; the floor/plain renders the Default artifact chip", () => {
    expect(LIB).toMatch(/identity\.kind === "extension"/);
    expect(LIB).toMatch(/extensionDisplayName\(identity\.extension\)/);
    expect(LIB).toMatch(/Default artifact/);
  });
});

describe("§IV — targeted-restore entry affordances deep-link to the console's nested restore route", () => {
  const TOAST = read("src/components/data-safety/undo-toast.tsx");
  const CHIP = read("packages/chat/src/chat-undo-action-chip.tsx");
  const CHIP_ACTION = read("packages/chat/src/undo-actions.ts");
  const RESTORE_ACTION = read("src/components/data-safety/restore-change-set-action.ts");

  it("undoDeepLink builds /configuration/artifacts/restore/<id> (url-encoded), not a legacy /artifacts?mode=undo link", () => {
    expect(TOAST).toMatch(
      /\/configuration\/artifacts\/restore\/\$\{encodeURIComponent\(changeSetId\)\}/,
    );
    expect(TOAST).not.toMatch(/artifacts\?mode=undo/);
  });

  it("the toast Undo affordance is server-side eligibility-gated (suppressed when ineligible, no admin bypass)", () => {
    expect(TOAST).toMatch(/canRestoreChangeSetAction\(\{ changeSetId \}\)/);
    expect(TOAST).toMatch(/if \(!eligible\) return;/);
    expect(RESTORE_ACTION).toMatch(/export async function canRestoreChangeSetAction/);
    expect(RESTORE_ACTION).toMatch(/isSessionEligibleForTargetedRestore/);
  });

  it("the chat undo chip links through undoDeepLink and carries the eligible conformance state", () => {
    expect(CHIP).toMatch(/undoDeepLink\(changeSetId\)/);
    expect(CHIP).toMatch(/data-conformance-id="artifacts-undo-entry"/);
    // The chip only appears when the shared per-object check returns eligible.
    expect(CHIP_ACTION).toMatch(/isSessionEligibleForTargetedRestore\(cs\.id\)/);
    expect(CHIP_ACTION).toMatch(/eligible \? \{ changeSetId: cs\.id \} : null/);
  });
});
