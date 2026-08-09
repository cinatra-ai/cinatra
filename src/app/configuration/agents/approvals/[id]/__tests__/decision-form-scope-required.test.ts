/**
 * ApprovalDecisionForm — the approvals DETAIL page's access-scope step
 * (cinatra#2597, honouring the cinatra#1327 contract).
 *
 * #1327 shipped the required access-scope step on the inbox row dialog only.
 * This form — the OTHER surface an admin approves from — had no picker at all,
 * so it could never satisfy the server's fail-closed requirement. These
 * assertions pin the same reuse + required-ness contract its sibling test
 * (src/lib/approvals/__tests__/agent-decision-actions-required.test.tsx) pins
 * for the inbox dialog, so the two approval surfaces cannot drift apart again.
 *
 * Per project convention the contract is locked via source-text assertions
 * (a jsdom AccessCombobox interaction is brittle, and the real security
 * boundary is server-side): the BEHAVIOURAL required-ness predicate is unit-
 * tested purely in src/components/__tests__/install-scope-picker-value.test.ts,
 * the row model in src/lib/approvals/__tests__/approval-scope-picker-model.test.ts,
 * and the server seam in ./approve-access-scope.test.ts.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "../decision-form.tsx"), "utf-8");

describe("ApprovalDecisionForm access-scope step", () => {
  it("declares 'use client' (the picker is interactive)", () => {
    const firstCodeLine = SOURCE.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(firstCodeLine.trim()).toMatch(/^["']use client["']/);
  });

  it("REUSES the shared AccessCombobox in installMode — not a forked selector", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/components\/access-combobox["']/);
    expect(SOURCE).toMatch(/<AccessCombobox/);
    expect(SOURCE).toMatch(/\binstallMode\b/);
  });

  it("REUSES the shared picker-value adapter, required-ness predicate and row model", () => {
    expect(SOURCE).toMatch(/from\s+["']@cinatra-ai\/agents\/auth-policy-types["']/);
    expect(SOURCE).toMatch(/canSubmitApprovalScope/);
    expect(SOURCE).toMatch(/pickerValueToTarget/);
    expect(SOURCE).toMatch(/approvalScopePickerModel/);
  });

  it("loads the SERVER-COMPUTED targets (never client-derived)", () => {
    expect(SOURCE).toMatch(/loadApprovalInstallScopeContext/);
  });

  it("REQUIRED-NESS: the approve submit is disabled until a grantable scope is chosen", () => {
    expect(SOURCE).toMatch(/const\s+canApprove\s*=/);
    expect(SOURCE).toMatch(/canSubmitApprovalScope\(\s*scopeValue/);
    expect(SOURCE).toMatch(/disabled=\{\s*!canApprove\s*\}/);
  });

  it("carries the chosen scope on the approve form so the server persists it", () => {
    expect(SOURCE).toMatch(/name="accessTargetLevel"/);
    expect(SOURCE).toMatch(/name="accessTargetId"/);
  });

  it("renders an empty-state when there is no installable scope (cannot approve)", () => {
    expect(SOURCE).toMatch(/noInstallableScope/);
  });

  it("no longer claims the approve publishes 'private-scoped' (it publishes to the chosen scope)", () => {
    expect(SOURCE).not.toMatch(/private-scoped/);
    expect(SOURCE).not.toMatch(/Approve &amp; publish \(private\)/);
    expect(SOURCE).toMatch(/Approve &amp; publish/);
  });

  it("uses semantic CSS tokens only — no bg-white / text-slate-* / border-gray-*", () => {
    const stripped = SOURCE.replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/bg-white\b/);
    expect(stripped).not.toMatch(/text-slate-/);
    expect(stripped).not.toMatch(/border-gray-/);
  });
});
