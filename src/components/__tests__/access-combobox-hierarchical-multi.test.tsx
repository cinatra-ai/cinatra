/**
 * Source-text contract test for AccessComboboxHierarchical's checkbox
 * multi-select mode (cinatra#1072, multi-scope W3). Component tests in this
 * repo use source-file text assertions (@testing-library/react is not
 * available from the root package.json) — mirrors the sibling
 * access-combobox-hierarchical-*.test.tsx files. The BEHAVIOUR of the toggle +
 * implication logic is covered by real unit tests in access-selection.test.ts;
 * this file locks the picker's WIRING of that logic + the render contract.
 *
 * Truths locked here:
 *  - a discriminated `multiple` prop union: multi ⇒ value: string[] /
 *    onChange(string[]); single (default) ⇒ value: string / onChange(string)
 *  - multi rows lead with a <Checkbox> and DROP the trailing Check icon
 *  - toggling a multi row goes through the pure toggleAccessSelection and keeps
 *    the popover OPEN (single mode still closes on select)
 *  - the row checked/disabled state comes from the pure accessRowState
 *  - the trigger renders resolveAccessSummary; N>1 surfaces the full list in a
 *    Tooltip
 *  - single-mode behaviour (trailing Check, close-on-select, width overlay) is
 *    preserved for the untouched filter-surface callers
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox-hierarchical";

const SOURCE = readFileSync("src/components/access-combobox-hierarchical.tsx", "utf-8");

describe("AccessComboboxHierarchical checkbox multi-select (cinatra#1072)", () => {
  it("module loads and exports the component", () => {
    expect(typeof Mod.AccessComboboxHierarchical).toBe("function");
  });

  it("exposes a discriminated `multiple` prop union (array value in multi mode)", () => {
    expect(SOURCE).toMatch(/multiple:\s*true/);
    expect(SOURCE).toMatch(/multiple\?:\s*false/);
    expect(SOURCE).toMatch(/value:\s*string\[\]/);
    expect(SOURCE).toMatch(/onChange:\s*\(next:\s*string\[\]\)\s*=>\s*void/);
    // single mode keeps the scalar shape for the filter callers
    expect(SOURCE).toMatch(/value:\s*string;/);
    expect(SOURCE).toMatch(/onChange:\s*\(next:\s*string\)\s*=>\s*void/);
  });

  it("renders a leading Checkbox in multi rows and no trailing Check there", () => {
    expect(SOURCE).toMatch(/import \{ Checkbox \} from "@\/components\/ui\/checkbox"/);
    expect(SOURCE).toMatch(/renderMultiRow/);
    const multiRow = SOURCE.slice(
      SOURCE.indexOf("const renderMultiRow"),
      SOURCE.indexOf("const renderMultiRow") + 700,
    );
    expect(multiRow).toMatch(/<Checkbox\b/);
    expect(multiRow).not.toMatch(/<Check\b/); // the trailing Check icon is single-mode only
  });

  it("toggles through the pure toggleAccessSelection BY DEFAULT (grant mode) and keeps the popover OPEN", () => {
    // The toggle + implication logic lives in the pure access-scope module
    // (co-located with the label helpers so it adds no new reachable module to
    // the routes that transitively reach the picker — the route-graph ratchet).
    expect(SOURCE).toMatch(
      /import \{[\s\S]*toggleAccessSelection[\s\S]*\} from "@\/components\/access-scope"/,
    );
    // Grant-mode fallback: an omitted override MUST delegate to the pure
    // grant helper (cinatra#1074 W5 made the semantics injectable; grant
    // surfaces pass no override and must stay behaviour-identical).
    expect(SOURCE).toMatch(/props\.toggleSelection \?\?/);
    expect(SOURCE).toMatch(/toggleAccessSelection\(value,\s*current\)/);
    // the multi onSelect branch does NOT close the popover
    expect(SOURCE).toMatch(/Popover stays OPEN on toggle/);
    // single mode still closes on select
    expect(SOURCE).toMatch(/props\.onChange\(itemValue\);\s*\n\s*setOpen\(false\)/);
  });

  it("derives row checked/disabled state from the pure accessRowState BY DEFAULT (grant mode)", () => {
    expect(SOURCE).toMatch(
      /\(props\.rowState \?\? accessRowState\)\(itemValue,\s*selection,\s*scopes\)/,
    );
  });

  it("multi mode accepts FILTER-surface overrides (cinatra#1074 W5) as optional props", () => {
    // The override props live on the MULTI branch of the discriminated union
    // only, typed against the same (value, selection) shapes as the grant
    // helpers, so a filter surface can swap semantics without forking the
    // picker (and single mode cannot receive them).
    expect(SOURCE).toMatch(/toggleSelection\?:\s*\(value:\s*string,\s*selection:\s*readonly string\[\]\)\s*=>\s*string\[\]/);
    expect(SOURCE).toMatch(/rowState\?:\s*\(/);
  });

  it("renders the trigger via resolveAccessSummary and a Tooltip for N>1", () => {
    expect(SOURCE).toMatch(/resolveAccessSummary\(/);
    expect(SOURCE).toMatch(/import \{[\s\S]*Tooltip[\s\S]*\} from "@\/components\/ui\/tooltip"/);
    expect(SOURCE).toMatch(/multiSelection\.length > 1/);
  });

  it("preserves single-mode behaviour for the untouched filter callers", () => {
    // trailing Check + selected-row bg + width-overlay template stay intact
    expect(SOURCE).toMatch(/renderSingleRow/);
    expect(SOURCE).toMatch(/Hidden width template/);
  });

  it("re-exports the pure label helpers for existing callers", () => {
    expect(SOURCE).toMatch(
      /export \{ resolveAccessParts, resolveAccessLabel, resolveAccessSummary \}/,
    );
  });
});
