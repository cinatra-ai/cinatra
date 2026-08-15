/**
 * Marketplace install-surface wiring contract (cinatra#805 → #2373 → #2374).
 *
 * This replaces `extension-install-scope-dialog.test.tsx`, which pinned the
 * pre-install access POPUP (`ExtensionInstallScopeDialog`). That component no
 * longer exists, because both of its consumers are gone:
 *
 *  - the CARD path moved to the in-card `ExtensionInstallScopePanel`
 *    (cinatra#2373), and
 *  - the §II detail modal — the popup's last consumer — was made DETAILS-ONLY
 *    by owner ruling (2026-08-04, landed in cinatra#2406). The pinned design
 *    contract (design `specs/app-extensions.html`, version 0.13.2, §II) reads:
 *    "The modal is details-only — it carries no footer and no
 *    install/update/restore action of its own … install/update/restore run
 *    from the §I ListingCard and the §III installed card, never from this
 *    dialog."
 *
 * cinatra#2374 (S3) therefore DELETES the dead popup rather than lifting a
 * panel into a modal footer that the owner removed. What survives here is the
 * wiring that is still real: the marketplace screen's install routing, the
 * access-stage failure copy, and a lock so the popup cannot quietly return.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

import { installAccessStageFailureCopy } from "../marketplace-failure-copy";

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, rel), "utf-8");

// The browse surface is TWO files since cinatra#2539 split the per-card node
// composition out of the screen (a verbatim move — the screen kept the auth/DB
// reads and the chrome). Every wiring invariant below is a property of the
// SURFACE, so it is pinned against both halves.
const SCREEN =
  read("../extensions-marketplace-screen.tsx") +
  "\n" +
  read("../marketplace-card-nodes.tsx") +
  "\n" +
  read("../marketplace-card-shell.tsx");
const MODAL = read("../marketplace-detail-modal.tsx");
const PANEL = read("../extension-install-scope-panel.tsx");

describe("marketplace screen wiring", () => {
  it("mounts the IN-CARD panel for connector/artifact/workflow installs — no popup on the card path", () => {
    expect(SCREEN).toMatch(/isInstallAccessTargetKind\(card\.kindSlug\)/);
    expect(SCREEN).toMatch(/<CardFaceSwitcher/);
    expect(SCREEN).toMatch(/<MarketplaceCardInstallShell/);
    expect(SCREEN).toMatch(/<ExtensionInstallScopePanel/);
    // The card's own CTA opens the panel; it never renders a popup.
    expect(SCREEN).toMatch(/<InstallPanelOpenButton>Install now<\/InstallPanelOpenButton>/);
    // The legacy direct path must survive for agent/skill/unknown kinds.
    expect(SCREEN).toMatch(/<MarketplaceInstallForm/);
  });

  it("computes the picker rows with the SHARED server-side builder and defaults via the marketplace-local availability model", () => {
    expect(SCREEN).toMatch(/buildInstallTargetPickerContext/);
    expect(SCREEN).toMatch(
      /from\s+["']@cinatra-ai\/agents\/install-target-picker["']/,
    );
    // The org-first override is retired: the default AUDIENCE is now
    // `Workspace: All`, resolved (with the no-active-organization / empty-state
    // ordering) by the marketplace-local model. The SHARED default helper stays
    // untouched and is consulted only as the fallback.
    expect(SCREEN).toMatch(/resolveInstallPanelAvailability\(\{/);
    expect(SCREEN).toMatch(/fallbackDefaultValue: pickerFallbackValue/);
    expect(SCREEN).not.toMatch(
      /t\.level === ["']organization["'] && !t\.disabled/,
    );
  });

  it("passes the UNBOUND action so the panel threads accessTarget itself", () => {
    // The screen publishes the UNBOUND action to the grid-level install context
    // (cinatra#2539); the panel reads it from there and threads accessTarget
    // itself. The bound `.bind()` variants remain the form CTAs' actions.
    expect(SCREEN).toMatch(/installAction: installExtensionPackageFormAction/);
    expect(SCREEN).toMatch(/<InstallPanelScopeProvider/);
  });
});

describe("the pre-install access popup is gone for good (cinatra#2374)", () => {
  it("the component module no longer exists", () => {
    expect(
      existsSync(path.resolve(__dirname, "../extension-install-scope-dialog.tsx")),
    ).toBe(false);
  });

  it("no marketplace surface imports or mounts it", () => {
    // Mount/import shaped (not a bare identifier match) so the surrounding
    // comments may still explain WHY it was removed.
    for (const source of [SCREEN, MODAL, PANEL]) {
      expect(source).not.toMatch(/<ExtensionInstallScopeDialog/);
      expect(source).not.toMatch(
        /from\s+["']\.\/extension-install-scope-dialog["']/,
      );
    }
  });

  it("the in-card panel is the single value→target adapter consumer on this surface", () => {
    // The popup carried a private duplicate of the picker→target rules. With it
    // gone the panel imports the shared pure module, so the marketplace surface
    // has exactly ONE implementation of the fail-closed adapter.
    expect(PANEL).toMatch(/from\s+["']\.\/install-picker-target["']/);
    expect(PANEL).toMatch(/pickerValueToInstallTarget\(value, activeOrgId\)/);
  });
});

describe("contracts inherited by the panel from the deleted popup", () => {
  // These two were pinned on the popup's source and would otherwise stop being
  // pinned anywhere when it was deleted. The panel implements both; pin them
  // there so the guarantee survives the component swap.
  it("re-throws the NEXT_REDIRECT sentinel so the success path still navigates", () => {
    expect(PANEL).toMatch(/from\s+["']\.\/is-redirect-error["']/);
    expect(PANEL).toMatch(/isRedirectError\(error\)/);
    // The sentinel is re-thrown (Next performs the navigation), and the success
    // toast fires before it — never swallowed into the failure branch. Anchored
    // on the catch's OWN closing brace (4-space), not the enclosing function's.
    const catchBlock = PANEL.match(/catch \(error\) \{[\s\S]*?\n {4}\}/)?.[0];
    expect(catchBlock).toBeTruthy();
    const at = (needle: string) => {
      const i = catchBlock!.indexOf(needle);
      expect(i, `expected ${needle} inside the catch block`).toBeGreaterThan(-1);
      return i;
    };
    // Order inside the catch: success toast -> re-throw -> (only otherwise) the
    // failure report.
    expect(at("toast.success(")).toBeLessThan(at("throw error;"));
    expect(at("throw error;")).toBeLessThan(at("reportFailure(defaultFailureMessage)"));
  });

  it("maps classified failures to copy, with the access stages getting their own", () => {
    expect(PANEL).toMatch(/result\.ok === false/);
    expect(PANEL).toMatch(
      /failureCopyByCategory\[result\.category\]\s*\?\?\s*defaultFailureMessage/,
    );
    // Access-stage failures do NOT go through the category map — they carry the
    // rolled-back / installed-with-default-access distinction.
    expect(PANEL).toMatch(/installAccessStageFailureCopy\(result\.stage, name\)/);
    for (const stage of ["access", "access-partial", "access-required"]) {
      expect(PANEL).toContain(`result.stage === "${stage}"`);
    }
    // And the opaque diagnostic reference is still appended (cinatra#1539).
    expect(PANEL).toMatch(/appendDiagnosticReference\(/);
  });
});

describe("installAccessStageFailureCopy", () => {
  it("'access' says nothing was installed (rolled back) and retry is safe", () => {
    const copy = installAccessStageFailureCopy("access", "Foo");
    expect(copy).toContain("nothing was installed");
    expect(copy).toContain("Foo");
  });

  it("'access-partial' says it IS installed with the default access", () => {
    const copy = installAccessStageFailureCopy("access-partial", "Foo");
    expect(copy).toContain("was installed");
    expect(copy).toContain("default access");
  });
});
