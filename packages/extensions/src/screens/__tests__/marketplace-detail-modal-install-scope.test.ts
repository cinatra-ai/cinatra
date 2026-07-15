/**
 * Install-access-scope wiring for the §II detail modal (cinatra#1541).
 *
 * The "More details" modal's footer "Install now" used to submit the install
 * DIRECTLY for every kind, skipping the pre-install access-scope dialog the
 * §I/§IV card opens for connector / artifact / workflow (cinatra#805). That is
 * an access-configuration bypass: the same extension could persist a different
 * access outcome depending on where it was installed from. This pins the fix.
 *
 * Same convention as the sibling scope-dialog / modal-contract tests
 * (source-text assertions — jsdom Radix nesting is brittle and the actual
 * authorization boundary is the server action; the layered-dialog focus / ESC
 * / scroll-lock behaviour is proven on the live surface, not here).
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const MODAL = readFileSync(
  path.resolve(__dirname, "../marketplace-detail-modal.tsx"),
  "utf-8",
);
const DIALOG = readFileSync(
  path.resolve(__dirname, "../extension-install-scope-dialog.tsx"),
  "utf-8",
);
const SCREEN = readFileSync(
  path.resolve(__dirname, "../extensions-marketplace-screen.tsx"),
  "utf-8",
);

describe("marketplace detail modal — install access-scope (cinatra#1541)", () => {
  it("AC1/AC5: the footer install CTA is gated by the SAME isInstallAccessTargetKind predicate", () => {
    // The bypass is gone: the modal footer now consults the same predicate the
    // card uses (never a second rule), and only for the install (not update) op.
    expect(MODAL).toMatch(/from\s+["']\.\.\/install-access-target["']/);
    expect(MODAL).toMatch(/!isUpdate\s*&&\s*isInstallAccessTargetKind\(card\.kindSlug\)/);
  });

  it("AC1: the access-target install branch renders ExtensionInstallScopeDialog, not a direct submit", () => {
    expect(MODAL).toMatch(/from\s+["']\.\/extension-install-scope-dialog["']/);
    expect(MODAL).toMatch(/<ExtensionInstallScopeDialog/);
    // The direct-submit MarketplaceInstallForm still exists (non-access kinds +
    // update + restore), but the access-target install path does NOT use it.
    const branch = MODAL.match(
      /if \(!isUpdate && isInstallAccessTargetKind\(card\.kindSlug\)\) \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(branch).toBeTruthy();
    expect(branch).not.toMatch(/MarketplaceInstallForm/);
    expect(branch).toMatch(/<ModalInstallScopeCta/);
  });

  it("AC2: an access-target kind with NO scope context DEFERS (disabled CTA) — never a silent direct submit", () => {
    const branch = MODAL.match(
      /if \(!isUpdate && isInstallAccessTargetKind\(card\.kindSlug\)\) \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(branch).toMatch(/if \(!installScope\)/);
    // The absence path returns a DISABLED button, not MarketplaceInstallForm.
    const absent = branch!.match(/if \(!installScope\) \{[\s\S]*?\n    \}/)?.[0];
    expect(absent).toMatch(/<Button[\s\S]*disabled/);
    expect(absent).not.toMatch(/MarketplaceInstallForm/);
  });

  it("AC1/AC6: the modal drives the dialog with the card's UNBOUND object-arg action + the same identifiers", () => {
    // The scope CTA subcomponent passes packageName/packageVersion/displayName
    // from `card` and the plumbed action/target rows — the SAME server contract
    // the card wires, so both entry points persist the same access outcome.
    // (These wirings are unique to ModalInstallScopeCta in this file.)
    expect(MODAL).toMatch(/function ModalInstallScopeCta\(/);
    expect(MODAL).toMatch(/packageName=\{card\.packageName\}/);
    expect(MODAL).toMatch(/packageVersion=\{card\.packageVersion\}/);
    expect(MODAL).toMatch(/installAction=\{installScope\.installAction\}/);
    expect(MODAL).toMatch(/installTargets=\{installScope\.installTargets\}/);
    expect(MODAL).toMatch(/defaultValue=\{installScope\.defaultValue\}/);
  });

  it("AC4: the modal drives the dialog CONTROLLED-open from its own CTA (layers above the modal)", () => {
    // The footer button is the trigger; it opens the dialog via controlled open.
    expect(MODAL).toMatch(/onClick=\{\(\) => setScopeOpen\(true\)\}/);
    expect(MODAL).toMatch(/open=\{scopeOpen\}/);
    expect(MODAL).toMatch(/onOpenChange=\{setScopeOpen\}/);
  });

  it("AC4: focus returns to the modal CTA on close — the modal overrides Radix's null-trigger autofocus", () => {
    // The controlled scope dialog suppresses its Radix trigger, so Radix cannot
    // restore focus to it; the modal preventDefaults and focuses its own CTA ref.
    expect(MODAL).toMatch(/const ctaRef = useRef<HTMLButtonElement>\(null\);/);
    expect(MODAL).toMatch(/<Button ref=\{ctaRef\}/);
    expect(MODAL).toMatch(/onCloseAutoFocus=\{\(event\) =>/);
    expect(MODAL).toMatch(/event\.preventDefault\(\);/);
    expect(MODAL).toMatch(/ctaRef\.current\?\.focus\(\);/);
    // The dialog forwards the handler to its DialogContent.
    expect(DIALOG).toMatch(/onCloseAutoFocus\?:\s*\(event:\s*Event\)\s*=>\s*void;/);
    expect(DIALOG).toMatch(/<DialogContent onCloseAutoFocus=\{onCloseAutoFocus\}>/);
  });

  it("AC7: the update flow is untouched — the access branch excludes isUpdate and sits after the update-plan branch", () => {
    // ModalUpdatePlanFlow is resolved BEFORE the install-access branch, and the
    // access branch is guarded by !isUpdate, so update behaviour is unchanged.
    expect(MODAL.indexOf("ModalUpdatePlanFlow")).toBeLessThan(
      MODAL.indexOf("isInstallAccessTargetKind(card.kindSlug)"),
    );
  });
});

describe("ExtensionInstallScopeDialog — controlled-open plumbing (cinatra#1541)", () => {
  it("exposes opt-in controlled open (open / onOpenChange) props", () => {
    expect(DIALOG).toMatch(/open\?:\s*boolean;/);
    expect(DIALOG).toMatch(/onOpenChange\?:\s*\(open:\s*boolean\)\s*=>\s*void;/);
    expect(DIALOG).toMatch(/const isControlled = controlledOpen !== undefined;/);
    // Controlled callers forward to the parent's setter; the card keeps local.
    expect(DIALOG).toMatch(/if \(isControlled\) controlledOnOpenChange\?\.\(next\);/);
  });

  it("SUPPRESSES its built-in trigger when controlled (the modal CTA drives it)", () => {
    // A controlled caller renders no internal DialogTrigger button, so the
    // dialog can layer above the caller's already-open modal.
    expect(DIALOG).toMatch(/isControlled \? null : \(/);
    // Uncontrolled (card) still renders the built-in "Install now" trigger.
    expect(DIALOG).toMatch(/<DialogTrigger asChild>/);
  });

  it("org:<id> token round-trip is preserved on this path (id-carrying org token → target)", () => {
    // The same adapter the card path relies on (#1562 org:<id> contract) is the
    // one the modal path now reaches — unchanged, so the token round-trips.
    expect(DIALOG).toMatch(/value\.startsWith\(["']org:["']\)/);
    expect(DIALOG).toMatch(/level:\s*["']organization["']/);
  });
});

describe("marketplace screen — install-scope plumbing into the modal (cinatra#1541)", () => {
  it("AC2/AC3: passes installScope from the SAME already-authorized server-computed context the card uses", () => {
    // The modal now receives the scope bundle, built from the identical rows
    // the card's ExtensionInstallScopeDialog receives — no broader lookup.
    const modalUse = SCREEN.match(/<MarketplaceDetailModal[\s\S]*?\/>/)?.[0];
    expect(modalUse).toBeTruthy();
    expect(modalUse).toMatch(/installScope=\{/);
    expect(modalUse).toMatch(/isInstallAccessTargetKind\(card\.kindSlug\)/);
    expect(modalUse).toMatch(/installTargets,/);
    expect(modalUse).toMatch(/ownerEntityNames,/);
    expect(modalUse).toMatch(/activeOrgId,/);
    expect(modalUse).toMatch(/defaultValue:\s*installScopeDefaultValue,/);
    // The UNBOUND action so the dialog threads accessTarget (same as the card).
    expect(modalUse).toMatch(/installAction:\s*installExtensionPackageFormAction,/);
  });

  it("AC3: non-access kinds receive no scope context (undefined) — the modal keeps its direct-submit path", () => {
    const modalUse = SCREEN.match(/<MarketplaceDetailModal[\s\S]*?\/>/)?.[0];
    expect(modalUse).toMatch(/:\s*undefined/);
  });
});
