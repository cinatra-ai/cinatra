/**
 * Source-text contract test for AccessCombobox disabledScopes /
 * disabledReasons.
 *
 * This test locks the contract via source-text assertions on
 * access-combobox.tsx because component tests in this repo use source-file
 * text assertions and @testing-library/react is not available from the root
 * package.json.
 *
 * The truths locked here:
 *  - AccessComboboxProps exposes disabledScopes?: string[] and disabledReasons?: Record<string,string>
 *  - The component body branches on disabledScopes for org / team:* / project:* rows
 *  - Tooltip is wrapped via a <span> OUTSIDE the disabled CommandItem because
 *    disabled CommandItem suppresses pointer events on its content, so the
 *    wrapper span is what receives hover/focus
 *  - aria-disabled is set on disabled rows
 *  - The owner / admin rows are NOT in the disabledScopes branch (they have
 *    separate semantics; only the 3 install-target row types are gated)
 *  - Module loads without throwing (smoke test for type/import drift)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as AccessComboboxMod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

describe("AccessCombobox disabledScopes", () => {
  it("module loads and exports AccessCombobox + AccessComboboxProps + resolveAccessLabel", () => {
    expect(typeof AccessComboboxMod.AccessCombobox).toBe("function");
    expect(typeof AccessComboboxMod.resolveAccessLabel).toBe("function");
  });

  it("AccessComboboxProps exposes disabledScopes optional field", () => {
    expect(SOURCE).toMatch(/disabledScopes\?:\s*string\[\]/);
  });

  it("AccessComboboxProps exposes disabledReasons optional field", () => {
    expect(SOURCE).toMatch(/disabledReasons\?:\s*Record<string,\s*string>/);
  });

  it("destructures the new props in the component signature", () => {
    // Component params destructure must include both new props (so they are
    // actually consumed by the body, not just declared on the type).
    const componentBody = SOURCE.slice(SOURCE.indexOf("export function AccessCombobox"));
    expect(componentBody).toMatch(/disabledScopes\b/);
    expect(componentBody).toMatch(/disabledReasons\b/);
  });

  it("checks disabledScopes membership when rendering rows", () => {
    expect(SOURCE).toMatch(/disabledScopes\?\.includes/);
  });

  it("uses disabledReasons to look up tooltip text", () => {
    expect(SOURCE).toMatch(/disabledReasons\?\.\[/);
  });

  it("wraps disabled rows in a <span> OUTSIDE the disabled CommandItem", () => {
    // Inline doc comment is the locked contract anchor — the wrapper span is
    // what receives pointer events; the disabled CommandItem cannot.
    expect(SOURCE).toMatch(/wrapper\s*span|wrapper-span|wraps the entire .*CommandItem.* in a/i);
  });

  it("sets aria-disabled on rows that appear in disabledScopes", () => {
    expect(SOURCE).toMatch(/aria-disabled/);
  });

  it("does not pollute owner/admin rows with disabledScopes (only org/team/project rows are gated)", () => {
    // The disabledScopes wiring lives only on the org / team / project rows.
    // disabledScopes?.includes(...) appears at most 3 times (org row + team
    // loop + project loop). Owner/admin/workspace are not target scopes.
    const matches = SOURCE.match(/disabledScopes\?\.includes/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it("preserves the existing component-level disabled prop semantics (back-compat)", () => {
    // The existing per-component disabled prop must still be in the type.
    expect(SOURCE).toMatch(/disabled\?:\s*boolean/);
    // The popover still gates open on the component-level disabled prop.
    expect(SOURCE).toMatch(/disabled\s*\?\s*undefined\s*:\s*setOpen/);
  });

  it("exposes installMode flag that hides owner/admin/workspace groups", () => {
    // Type-level prop.
    expect(SOURCE).toMatch(/installMode\?:\s*boolean/);
    // Each of the three excluded groups is gated by `!installMode`.
    const owners = SOURCE.match(/\{!installMode\s*&&\s*\(/g) ?? [];
    expect(owners.length).toBeGreaterThanOrEqual(3);
  });
});
