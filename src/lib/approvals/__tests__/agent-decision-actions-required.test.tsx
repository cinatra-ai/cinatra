/**
 * AgentDecisionActions — approval access-scope required-ness contract (cinatra#1327).
 *
 * Per project convention (jsdom Radix Dialog + AccessCombobox interaction is
 * brittle; the actual security boundary is server-side), the required-ness +
 * reuse contract is locked via source-text assertions. The BEHAVIOURAL
 * required-ness predicate itself (submit disabled without a selection) is unit-
 * tested purely in ../../../../components/__tests__/install-scope-picker-value.test.ts.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../agent-decision-actions.tsx"),
  "utf-8",
);

describe("AgentDecisionActions approval scope step", () => {
  it("declares 'use client'", () => {
    expect(SOURCE.split("\n")[0].trim()).toMatch(/^["']use client["']/);
  });

  it("REUSES the shared AccessCombobox (org/team/project rows) — not a forked selector", () => {
    expect(SOURCE).toMatch(/from\s+["']@\/components\/access-combobox["']/);
    expect(SOURCE).toMatch(/<AccessCombobox/);
    // installMode hides owner/admin/workspace rows — parity with the install dialog.
    expect(SOURCE).toMatch(/\binstallMode\b/);
  });

  it("REUSES the shared picker-value adapter + required-ness predicate", () => {
    expect(SOURCE).toMatch(/from\s+["']@cinatra-ai\/agents\/auth-policy-types["']/);
    expect(SOURCE).toMatch(/canSubmitApprovalScope/);
    expect(SOURCE).toMatch(/pickerValueToTarget/);
  });

  it("loads the SERVER-COMPUTED targets (never client-derived)", () => {
    expect(SOURCE).toMatch(/loadApprovalInstallScopeContext/);
  });

  it("REQUIRED-NESS: the confirm submit is disabled until a scope is chosen", () => {
    // The confirm button binds disabled to canConfirm (built from
    // canSubmitApprovalScope) — a submit is impossible with no selection.
    expect(SOURCE).toMatch(/const\s+canConfirm\s*=/);
    expect(SOURCE).toMatch(/canSubmitApprovalScope\(\s*scopeValue/);
    expect(SOURCE).toMatch(/disabled=\{\s*!canConfirm\s*\|\|\s*pending\s*\}/);
  });

  it("carries the chosen scope on the approve form so the server persists it", () => {
    expect(SOURCE).toMatch(/name="accessTargetLevel"/);
    expect(SOURCE).toMatch(/name="accessTargetId"/);
    expect(SOURCE).toMatch(/name="action"\s+value="approve"/);
  });

  it("renders an empty-state when there is no installable scope (cannot approve)", () => {
    expect(SOURCE).toMatch(/noInstallableScope/);
    expect(SOURCE).toMatch(/variant="destructive"/);
  });

  it("labels the action as Approve & publish", () => {
    expect(SOURCE).toMatch(/Approve & publish|Approve &amp; publish/);
  });

  it("uses semantic CSS tokens only — no bg-white / text-slate-* / border-gray-*", () => {
    const stripped = SOURCE.replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/bg-white\b/);
    expect(stripped).not.toMatch(/text-slate-/);
    expect(stripped).not.toMatch(/border-gray-/);
  });
});
