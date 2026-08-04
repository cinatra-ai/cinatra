/**
 * ExtensionInstallScopeDialog — install access-scope required-ness lock.
 *
 * cinatra#1327 criterion (c): pin the marketplace install dialog's required-ness
 * too, so NEITHER surface (marketplace install nor agent-creation approval) can
 * silently regress to allowing a submit with no scope selected. Per project
 * convention (Radix Dialog jsdom interaction is brittle) this is a source-text
 * lock on the submit-disabled wiring.
 *
 * cinatra#2372 (mkt-install S1): required-ness is no longer bare value-truthiness
 * — it is COMMITTABILITY, `resolveFlatAccessOption(...).committable`, so a
 * synthetic/degenerate selection (an empty-tail `org:` default, a mismatched org
 * id, an unhydrated team/project) can be truthy and STILL leave the submit
 * disabled. This closes the reachable defect where an admin with no active
 * organization got an enabled empty-tail `org:` default whose submit the
 * adapter then rejected server-side.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../extension-install-scope-dialog.tsx"),
  "utf-8",
);

describe("ExtensionInstallScopeDialog required-ness", () => {
  it("declares 'use client'", () => {
    expect(SOURCE.split("\n")[0].trim()).toMatch(/^["']use client["']/);
  });

  it("REQUIRED-NESS: the install submit is disabled unless the selected value is COMMITTABLE (cinatra#2372)", () => {
    // The submit is gated on resolveFlatAccessOption(...).committable — not
    // bare value-truthiness, so a synthetic/degenerate selection stays
    // disabled even though `value` itself is a non-empty string.
    expect(SOURCE).toMatch(/<InstallSubmitButton\s+disabled=\{!selectedOption\.committable\}/);
    // The gate is computed once, from the shared flat-option resolver, fed the
    // server-side disabledScopes and the actual offered-workspace-scopes flag
    // (never a hardcoded true — a row that was never rendered can never be
    // committable).
    expect(SOURCE).toMatch(/resolveFlatAccessOption\(value, availableScopes, \{/);
    expect(SOURCE).toMatch(/disabledScopes,/);
    expect(SOURCE).toMatch(/ownerOffered:\s*false,/);
    expect(SOURCE).toMatch(/workspaceOffered:\s*installWorkspaceScopes,/);
    expect(SOURCE).toMatch(/adminOffered:\s*installWorkspaceScopes,/);
    // And the pending-aware button keeps the disabled prop (never drops it).
    expect(SOURCE).toMatch(/function\s+InstallSubmitButton\(\{\s*disabled\b/);
    expect(SOURCE).toMatch(/disabled=\{disabled\s*\|\|\s*pending\}/);
  });

  it("the submit handler ALSO re-checks committability (defense in depth, not just the button's disabled prop)", () => {
    expect(SOURCE).toMatch(/if \(!target \|\| !selectedOption\.committable\)/);
  });

  it("only renders the submit when there IS an installable scope", () => {
    // noInstallableScope short-circuits to the empty-state Alert (no submit).
    expect(SOURCE).toMatch(/!noInstallableScope\s*\?/);
    expect(SOURCE).toMatch(/noInstallableScope\s*\?[\s\S]*variant="destructive"/);
  });
});
