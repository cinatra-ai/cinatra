/**
 * Source-text contract test for the unified AccessCombobox's multi-select
 * disabledScopes / disabledReasons (cinatra#1607; formerly cinatra#953 W3 on
 * AccessComboboxHierarchical — the per-scope disable the connection share
 * surface renders a connector's `only:*` ceiling with).
 *
 * Mirrors access-combobox-disabled-scopes.test.tsx (the single-mode sibling):
 * component tests in this repo use source-file text assertions
 * (@testing-library/react is not available from the root package.json).
 *
 * Truths locked here (the selectionMode="multiple" half):
 *  - the multi props expose disabledScopes?: string[] and
 *    disabledReasons?: Record<string,string>
 *  - the multi component consumes both props (destructured in its signature)
 *  - ONE uniform selectable-row builder branches on disabledScopes membership
 *    for EVERY scope class (owner / project / team / org / workspace / admin)
 *  - the tooltip is carried by a <span> wrapper OUTSIDE the disabled
 *    CommandItem (a disabled CommandItem suppresses pointer events)
 *  - aria-disabled is set on disabled rows
 *  - the component-level `disabled` prop semantics stay intact (back-compat)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

describe("AccessCombobox multi-select disabledScopes (cinatra#1607)", () => {
  it("module loads and exports the unified AccessCombobox", () => {
    expect(typeof Mod.AccessCombobox).toBe("function");
  });

  it("exposes the disabledScopes and disabledReasons optional props", () => {
    expect(SOURCE).toMatch(/disabledScopes\?:\s*string\[\]/);
    expect(SOURCE).toMatch(/disabledReasons\?:\s*Record<string,\s*string>/);
  });

  it("destructures both props in the multi component signature", () => {
    const body = SOURCE.slice(SOURCE.indexOf("function AccessComboboxMultiSelect"));
    expect(body).toMatch(/disabledScopes\b/);
    expect(body).toMatch(/disabledReasons\b/);
  });

  it("checks disabledScopes membership through ONE uniform row builder", () => {
    expect(SOURCE).toMatch(/disabledScopes\?\.includes/);
    expect(SOURCE).toMatch(/renderSelectableItem/);
    // Every scope class routes through the uniform builder: the six render
    // sites (owner, project map, team map, org map, workspace, admin).
    const uses = SOURCE.match(/renderSelectableItem\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(6);
  });

  it("uses disabledReasons for the tooltip text on a wrapper span outside the disabled CommandItem", () => {
    expect(SOURCE).toMatch(/disabledReasons\?\.\[/);
    // The wrapper span is what receives hover/focus — locked contract anchor.
    expect(SOURCE).toMatch(/wrapper span|wraps the entire disabled/i);
    expect(SOURCE).toMatch(/<span key=\{itemValue\} title=\{reason\}/);
  });

  it("sets aria-disabled on disabled rows", () => {
    expect(SOURCE).toMatch(/aria-disabled/);
  });

  it("preserves the component-level disabled prop semantics (back-compat)", () => {
    expect(SOURCE).toMatch(/disabled\?:\s*boolean/);
    expect(SOURCE).toMatch(/!disabled && setOpen\(next\)/);
  });
});
