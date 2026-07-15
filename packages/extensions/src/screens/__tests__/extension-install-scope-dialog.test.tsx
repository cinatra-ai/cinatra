/**
 * ExtensionInstallScopeDialog contract test (cinatra#805).
 *
 * Same convention as the agent InstallScopeDialog test (source-text
 * assertions — jsdom Radix interaction is brittle and the actual security
 * boundary is the server action's install-target-authz gate):
 *  - "use client" + prop-passed server action (never imported from ../actions)
 *  - AccessCombobox in installMode over server-computed InstallTarget rows
 *  - value→target adapter handles org / team:* / project:* and rejects the rest
 *  - classified-failure contract: { ok:false, category, stage? } → copy map,
 *    access stages get their own copy
 *  - NEXT_REDIRECT sentinel re-thrown (success path navigates)
 *  - marketplace screen wiring: the connector/artifact/workflow install CTA
 *    renders the dialog; other kinds keep MarketplaceInstallForm
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

import { installAccessStageFailureCopy } from "../marketplace-failure-copy";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../extension-install-scope-dialog.tsx"),
  "utf-8",
);
const SCREEN = readFileSync(
  path.resolve(__dirname, "../extensions-marketplace-screen.tsx"),
  "utf-8",
);

describe("ExtensionInstallScopeDialog", () => {
  it("declares 'use client'", () => {
    expect(SOURCE.split("\n")[0].trim()).toMatch(/^["']use client["']/);
  });

  it("accepts installAction as a prop instead of importing it directly", () => {
    // Importing "../actions" would pull server-only modules into the client
    // bundle (same hot-fix rationale as the agent dialog).
    expect(SOURCE).toMatch(/installAction:\s*ExtensionInstallAction/);
    expect(SOURCE).not.toMatch(/^import[^;]+from\s+["']\.\.\/actions["']/m);
    expect(SOURCE).toMatch(/await\s+installAction\(/);
  });

  it("imports the InstallTarget row type TYPE-ONLY from the shared agents module", () => {
    // A value import would execute the module's `import "server-only"` guard
    // in the client bundle.
    expect(SOURCE).toMatch(
      /import\s+type\s+\{\s*InstallTarget\s*\}\s+from\s+["']@cinatra-ai\/agents\/install-targets["']/,
    );
  });

  it("renders AccessCombobox in installMode (owner/admin/workspace rows hidden)", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/components\/access-combobox["']/);
    expect(SOURCE).toMatch(/installMode/);
    expect(SOURCE).toMatch(/workspaceExposed:\s*false/);
  });

  it("value→target adapter maps org / team:* / project:* and defensively rejects the rest", () => {
    expect(SOURCE).toMatch(/value === ["']org["']/);
    expect(SOURCE).toMatch(/startsWith\(["']team:["']\)/);
    expect(SOURCE).toMatch(/startsWith\(["']project:["']\)/);
    expect(SOURCE).toMatch(/return null;/);
    expect(SOURCE).toMatch(/level:\s*["']organization["']/);
  });

  it("threads the chosen target as accessTarget to the action", () => {
    expect(SOURCE).toMatch(/accessTarget:\s*target/);
  });

  it("re-throws the NEXT_REDIRECT sentinel (success path) and maps classified failures to copy", () => {
    expect(SOURCE).toMatch(/isRedirectError\(error\)/);
    expect(SOURCE).toMatch(/throw error;/);
    expect(SOURCE).toMatch(/result\.ok === false/);
    expect(SOURCE).toMatch(/failureCopyByCategory\[result\.category\]\s*\?\?\s*defaultFailureMessage/);
    expect(SOURCE).toMatch(/installAccessStageFailureCopy/);
  });

  it("uses the cinatra-toast wrapper (never raw sonner) and shadcn Dialog primitives", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/lib\/cinatra-toast["']/);
    expect(SOURCE).not.toMatch(/from\s+["']sonner["']/);
    expect(SOURCE).toMatch(/from\s+["']@\/components\/ui\/dialog["']/);
    expect(SOURCE).toMatch(/DialogContent/);
    expect(SOURCE).toMatch(/DialogTitle/);
  });

  it("shows the pending text swap + disabled submit (no isLoading prop on Button)", () => {
    expect(SOURCE).toMatch(/useFormStatus/);
    expect(SOURCE).toMatch(/pending \? ["']Installing\.\.\.["'] : ["']Install["']/);
    expect(SOURCE).not.toMatch(/isLoading=/);
  });

  it("titles the popup from the resolved displayName prop, never a package-name substitute (cinatra#1605)", () => {
    // The popup title binds `card.displayName` (passed as the displayName prop),
    // which the marketplace card model now resolves to a human name
    // (catalog display_name -> static manifest displayName -> package name LAST).
    // The dialog's own `|| packageName` is a defensive tail only — with a
    // resolved non-empty displayName it never triggers. Pin the binding so the
    // popup can never be refactored to title itself from the raw package name.
    expect(SOURCE).toMatch(/const\s+name\s*=\s*displayName\s*\|\|\s*packageName;/);
    expect(SOURCE).toMatch(/<DialogTitle>Install \{name\}<\/DialogTitle>/);
  });
});

describe("marketplace screen wiring", () => {
  it("renders the dialog for connector/artifact/workflow installs and keeps the plain form for other kinds", () => {
    expect(SCREEN).toMatch(/isInstallAccessTargetKind\(card\.kindSlug\)/);
    expect(SCREEN).toMatch(/<ExtensionInstallScopeDialog/);
    // The legacy path must survive for agent/skill/unknown kinds.
    expect(SCREEN).toMatch(/<MarketplaceInstallForm/);
  });

  it("computes the picker rows with the SHARED server-side builder and defaults to the org row", () => {
    expect(SCREEN).toMatch(/buildInstallTargetPickerContext/);
    expect(SCREEN).toMatch(
      /from\s+["']@cinatra-ai\/agents\/install-target-picker["']/,
    );
    // Org-first one-click default (parity with the implicit workspace default).
    expect(SCREEN).toMatch(
      /t\.level === ["']organization["'] && !t\.disabled/,
    );
  });

  it("passes the UNBOUND action so the dialog can thread accessTarget", () => {
    expect(SCREEN).toMatch(/installAction=\{installExtensionPackageFormAction\}/);
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
