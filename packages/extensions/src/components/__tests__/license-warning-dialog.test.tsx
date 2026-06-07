// LicenseWarningDialog static contract tests.
//
// Strategy: source-grep assertions (same pattern as publish-destination-picker.test.tsx
// and packages/agents pages.test.tsx). The extensions vitest config uses
// environment: "node" — RTL rendering is not available in this package sandbox.
// Static assertions verify the intended dialog behavior without requiring jsdom.
//
// Test 1: dialog title renders as `${spdxId} license detected`
//   → source contains template literal / string that formats the title with spdxId
// Test 2: body contains the verbatim copyleft warning copy
//   → source contains the locked body text referencing spdxId and copyleft
// Test 3: acknowledge button text is verbatim "I acknowledge this is copyleft and I want to proceed"
//   → source contains exact verbatim string
// Test 4: clicking acknowledge calls onAcknowledge
//   → source wires onAcknowledge into the AlertDialogAction onClick prop
// Test 5: clicking cancel closes the dialog (calls onOpenChange/onCancel)
//   → source wires onCancel into AlertDialogCancel onClick prop

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const srcPath = path.resolve(__dirname, "..", "license-warning-dialog.tsx");

function readSource(): string {
  return readFileSync(srcPath, "utf8");
}

describe("LicenseWarningDialog static contract", () => {
  it("Test 1: title format includes spdxId and 'license detected'", () => {
    const src = readSource();
    // The title must dynamically include the spdxId variable + "license detected"
    expect(src).toMatch(/license detected/);
    // The formatTitle or template must reference spdxId
    expect(src).toMatch(/spdxId/);
    // title composition must produce "{spdxId} license detected"
    expect(src).toMatch(/formatTitle|`\$\{spdxId\} license detected`/);
  });

  it("Test 2: body copy references spdxId and 'copyleft'", () => {
    const src = readSource();
    expect(src).toMatch(/copyleft/i);
    expect(src).toMatch(/formatBody|spdxId/);
    // The dynamic body copy must reference the license implications
    expect(src).toMatch(/released under the same license/);
  });

  it("Test 3: verbatim acknowledge button label present in source", () => {
    const src = readSource();
    expect(src).toContain("I acknowledge this is copyleft and I want to proceed");
  });

  it("Test 4: AlertDialogAction onClick is wired to onAcknowledge", () => {
    const src = readSource();
    // The action button must call onAcknowledge
    expect(src).toContain("onClick={onAcknowledge}");
    expect(src).toContain("AlertDialogAction");
  });

  it("Test 5: AlertDialogCancel onClick is wired to onCancel", () => {
    const src = readSource();
    // The cancel button must call onCancel
    expect(src).toContain("onClick={onCancel}");
    expect(src).toContain("AlertDialogCancel");
    // And the AlertDialog itself is controlled via open + onOpenChange
    expect(src).toMatch(/onOpenChange/);
  });

  it("Test 6: uses AlertDialog (not Dialog) for correct focus-trap semantics", () => {
    const src = readSource();
    // Must use AlertDialog components — not plain Dialog
    expect(src).toMatch(/AlertDialogContent/);
    expect(src).toMatch(/AlertDialogAction/);
    expect(src).toMatch(/AlertDialogCancel/);
  });

  it("Test 7: has 'use client' directive (client component)", () => {
    const src = readSource();
    expect(src.slice(0, 20)).toMatch(/"use client"/);
  });
});
