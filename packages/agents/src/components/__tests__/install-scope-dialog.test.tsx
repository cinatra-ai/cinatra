/**
 * InstallScopeDialog contract test.
 *
 * The dialog wraps shadcn Dialog + Radix primitives. Per project test
 * convention (see MEMORY: "Source-File Text Assertions via readFileSync"),
 * the bulk of the contract is locked via source-text assertions; jsdom
 * Radix interaction is brittle and the actual security boundary is
 * server-side installRegistryPackageAtScope authorization.
 *
 * Tests:
 *  - value→target adapter is wired (org / team:* / project:*)
 *  - defaultValue=null branch renders the destructive Alert (no AccessCombobox path)
 *  - server-error catch keeps dialog open + renders Alert
 *  - Install button uses text swap + disabled (NO isLoading prop on Button)
 *  - Success toast text composes from ownerEntityNames lookup
 *  - owner / admin / workspace are NOT passed to AccessCombobox
 *  - pickerValueToTarget returns null for the three excluded values (defensive)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import * as path from "node:path";
// Resolve relative to this test file so it works whether invoked from the
// repo root or from packages/agents.
const SOURCE = readFileSync(
  path.resolve(__dirname, "../install-scope-dialog.tsx"),
  "utf-8",
);

describe("InstallScopeDialog", () => {
  it("declares 'use client'", () => {
    expect(SOURCE.split("\n")[0].trim()).toMatch(/^["']use client["']/);
  });

  it("exports InstallScopeDialog", () => {
    expect(SOURCE).toMatch(/export\s+function\s+InstallScopeDialog/);
  });

  it("accepts installAction as a prop instead of importing it directly", () => {
    // Hot-fix: importing the server action from "../actions" pulled "server-only"
    // modules (bullmq, node:crypto) into the client bundle and broke build.
    // The action is now passed as a prop from the server-component caller.
    expect(SOURCE).toMatch(/installAction:\s*InstallScopeAction/);
    expect(SOURCE).not.toMatch(/^import[^;]+from\s+["']\.\.\/actions["']/m);
    expect(SOURCE).toMatch(/await\s+installAction\(/);
  });

  it("imports InstallTarget type from ../install-targets", () => {
    expect(SOURCE).toMatch(/InstallTarget/);
    expect(SOURCE).toMatch(/from\s+["']\.\.\/install-targets["']/);
  });

  it("imports AccessCombobox from @/components/access-combobox", () => {
    expect(SOURCE).toMatch(/AccessCombobox/);
    expect(SOURCE).toMatch(/from\s+["']@\/components\/access-combobox["']/);
  });

  it("imports shadcn Dialog primitives", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/components\/ui\/dialog["']/);
    expect(SOURCE).toMatch(/DialogContent/);
    expect(SOURCE).toMatch(/DialogTitle/);
  });

  it("imports shadcn Alert + Button + Label", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/components\/ui\/alert["']/);
    expect(SOURCE).toMatch(/from\s+["']@\/components\/ui\/button["']/);
    expect(SOURCE).toMatch(/from\s+["']@\/components\/ui\/label["']/);
  });

  it("imports toast from the @/lib/cinatra-toast wrapper", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/lib\/cinatra-toast["']/);
    // The dialog must NOT import from raw sonner — that bypasses the
    // Copy + Close affordances added by `@/lib/cinatra-toast`.
    expect(SOURCE).not.toMatch(/from\s+["']sonner["']/);
    // Nor from the legacy `@/lib/toast` path.
    expect(SOURCE).not.toMatch(/from\s+["']@\/lib\/toast["']/);
    expect(SOURCE).toMatch(/\btoast\b/);
  });

  // value→target adapter is wired
  it("D1: pickerValueToTarget adapter handles org / team:* / project:* values", () => {
    expect(SOURCE).toMatch(/value\s*===\s*["']org["']/);
    expect(SOURCE).toMatch(/team:/);
    expect(SOURCE).toMatch(/project:/);
    // adapter returns level / id triple
    expect(SOURCE).toMatch(/level:\s*["']organization["']/);
    expect(SOURCE).toMatch(/level:\s*["']team["']/);
    expect(SOURCE).toMatch(/level:\s*["']project["']/);
  });

  // defaultValue=null branch
  it("D2: defaultValue=null path renders a destructive Alert (no AccessCombobox in that branch)", () => {
    expect(SOURCE).toMatch(/defaultValue\s*===\s*null|defaultValue\s*==\s*null|!defaultValue|defaultValue\s*\?/);
    expect(SOURCE).toMatch(/Alert/);
    expect(SOURCE).toMatch(/variant=["']destructive["']/);
    // Empty-state copy locked by UI-SPEC.
    expect(SOURCE).toMatch(/org admin, team admin, or project ownership/);
  });

  // server error keeps dialog open
  it("D3: catches install errors and surfaces via errorMessage state (dialog stays open)", () => {
    expect(SOURCE).toMatch(/catch/);
    expect(SOURCE).toMatch(/setErrorMessage|errorMessage/);
  });

  // text swap + disabled (no isLoading)
  it("D4: Install button uses text swap + disabled (no isLoading prop)", () => {
    expect(SOURCE).toMatch(/Installing\.\.\./);
    expect(SOURCE).toMatch(/submitting/);
    // Strip block + line comments before checking — the doc header
    // intentionally references `isLoading` to lock the contract.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/isLoading/);
  });

  // Success toast composes scope label from ownerEntityNames
  it("D5: success toast composes 'at <scope>' from ownerEntityNames lookup", () => {
    expect(SOURCE).toMatch(/toast\.success/);
    expect(SOURCE).toMatch(/ownerEntityNames/);
    expect(SOURCE).toMatch(/Installed/);
  });

  // owner / admin / workspace excluded from AccessCombobox
  it("D6: passes workspaceExposed: false and installMode flag (hides owner/admin/workspace rows)", () => {
    expect(SOURCE).toMatch(/workspaceExposed:\s*false/);
    // installMode prop must be wired so AccessCombobox skips owner / admin /
    // workspace groups entirely.
    expect(SOURCE).toMatch(/\binstallMode\b/);
    // The pickerValueToTarget defensive guard returns null for the three
    // excluded values so a stray click cannot reach the server action.
    expect(SOURCE).toMatch(/return null|=> null/);
  });

  // pickerValueToTarget returns null for owner/admin/workspace
  it("D7: defensive null guard for non-install values (defensive guard documented)", () => {
    // Comment or code anchor that the three excluded values are caught.
    expect(SOURCE).toMatch(/owner|admin|workspace|defensive|not an install target/i);
  });

  it("derives availableScopes / disabledScopes / disabledReasons from installTargets", () => {
    expect(SOURCE).toMatch(/availableScopes/);
    expect(SOURCE).toMatch(/disabledScopes/);
    expect(SOURCE).toMatch(/disabledReasons/);
    expect(SOURCE).toMatch(/installTargets[\s\n]*\.\s*filter/);
  });

  it("COMMITTABILITY (cinatra#2372): the install submit is disabled unless the selected value is committable, not bare value-truthiness", () => {
    // Mirrors the marketplace extension dialog's gate (same shared model,
    // access-scope.ts's resolveFlatAccessOption) — a synthetic/degenerate
    // selection (an unhydrated team/project, or a stray org token) can be a
    // non-empty `value` and STILL leave submit disabled.
    expect(SOURCE).toMatch(/resolveFlatAccessOption\(value, availableScopes, \{/);
    expect(SOURCE).toMatch(/disabledScopes,/);
    expect(SOURCE).toMatch(/ownerOffered:\s*false,/);
    // This dialog never requests the always-offered workspace scopes
    // (installWorkspaceScopes is never passed to AccessCombobox below), so
    // "workspace"/"admin" can never be committable here — hardcoded false,
    // not a flag this dialog doesn't otherwise have.
    expect(SOURCE).toMatch(/workspaceOffered:\s*false,/);
    expect(SOURCE).toMatch(/adminOffered:\s*false,/);
    expect(SOURCE).toMatch(/disabled=\{!selectedOption\.committable \|\| submitting\}/);
    // Defense in depth: the submit handler ALSO re-checks committability, not
    // just the button's disabled prop.
    expect(SOURCE).toMatch(/if \(!target \|\| !selectedOption\.committable\)/);
  });

  it("no bare value-truthiness gate survives on the submit button (the old `!value` check is retired)", () => {
    expect(SOURCE).not.toMatch(/disabled=\{!value \|\| submitting\}/);
  });

  it("uses semantic CSS tokens only — no bg-white / text-slate-* / border-gray-* / bg-slate-*", () => {
    // Allow comments to reference these tokens for documentation; strip
    // single-line comments before scanning.
    const stripped = SOURCE.replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/bg-white\b/);
    expect(stripped).not.toMatch(/text-slate-/);
    expect(stripped).not.toMatch(/text-gray-/);
    expect(stripped).not.toMatch(/border-gray-/);
    expect(stripped).not.toMatch(/bg-slate-/);
  });
});
