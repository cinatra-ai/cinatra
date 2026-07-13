/**
 * ExtensionInstallScopeDialog — install access-scope required-ness lock.
 *
 * cinatra#1327 criterion (c): pin the marketplace install dialog's required-ness
 * too, so NEITHER surface (marketplace install nor agent-creation approval) can
 * silently regress to allowing a submit with no scope selected. Per project
 * convention (Radix Dialog jsdom interaction is brittle) this is a source-text
 * lock on the submit-disabled wiring.
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

  it("REQUIRED-NESS: the install submit is disabled with no scope value", () => {
    // The submit is gated on a truthy picker value — no selection ⇒ disabled.
    expect(SOURCE).toMatch(/<InstallSubmitButton\s+disabled=\{!value\}/);
    // And the pending-aware button keeps the disabled prop (never drops it).
    expect(SOURCE).toMatch(/function\s+InstallSubmitButton\(\{\s*disabled\b/);
    expect(SOURCE).toMatch(/disabled=\{disabled\s*\|\|\s*pending\}/);
  });

  it("only renders the submit when there IS an installable scope", () => {
    // noInstallableScope short-circuits to the empty-state Alert (no submit).
    expect(SOURCE).toMatch(/!noInstallableScope\s*\?/);
    expect(SOURCE).toMatch(/noInstallableScope\s*\?[\s\S]*variant="destructive"/);
  });
});
