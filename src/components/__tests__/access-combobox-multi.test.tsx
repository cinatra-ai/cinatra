/**
 * Source-text contract test for the unified AccessCombobox's checkbox
 * multi-select mode — `selectionMode="multiple"` (cinatra#1607 AC1; formerly the
 * standalone AccessComboboxHierarchical, cinatra#1072 multi-scope W3). Component
 * tests in this repo use source-file text assertions (@testing-library/react is
 * not available from the root package.json); the BEHAVIOUR of the toggle +
 * implication logic is covered by real unit tests in access-selection.test.ts,
 * and the trigger-open behaviour by access-combobox-multi-open.test.tsx. This
 * file locks the picker's WIRING of that logic + the render contract.
 *
 * Truths locked here:
 *  - ONE picker component parameterized by `selectionMode` — no separate
 *    AccessComboboxHierarchical export survives the consolidation
 *  - a discriminated `selectionMode` prop union: "multiple" ⇒ value: string[] /
 *    onChange(string[]); "single" (default) ⇒ value: string /
 *    onValueChange(string)
 *  - multi rows lead with a <Checkbox> and DROP the trailing Check icon
 *  - toggling a multi row goes through the pure toggleAccessSelection and keeps
 *    the popover OPEN (single mode still closes on select)
 *  - the row checked/disabled state comes from the pure accessRowState
 *  - the trigger renders resolveAccessSummary; N>1 surfaces the full list in a
 *    Tooltip
 *  - the pure label helpers are re-exported for existing callers
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

describe("AccessCombobox checkbox multi-select — selectionMode=\"multiple\" (cinatra#1607 / #1072)", () => {
  it("exposes ONE picker component and no residual hierarchical export", () => {
    expect(typeof Mod.AccessCombobox).toBe("function");
    expect(
      (Mod as Record<string, unknown>).AccessComboboxHierarchical,
    ).toBeUndefined();
    // The dispatcher branches on the selectionMode discriminant.
    expect(SOURCE).toMatch(/props\.selectionMode === "multiple"/);
  });

  it("exposes a discriminated `selectionMode` prop union (array value in multi mode)", () => {
    expect(SOURCE).toMatch(/selectionMode:\s*"multiple"/);
    expect(SOURCE).toMatch(/selectionMode\?:\s*"single"/);
    expect(SOURCE).toMatch(/value:\s*string\[\]/);
    expect(SOURCE).toMatch(/onChange:\s*\(next:\s*string\[\]\)\s*=>\s*void/);
    // single mode keeps the scalar shape for the flat/install/permissions callers
    expect(SOURCE).toMatch(/value:\s*string;/);
    expect(SOURCE).toMatch(/onValueChange:\s*\(value:\s*string\)\s*=>\s*void/);
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
    // Grant-mode fallback: an omitted override MUST delegate to the pure grant
    // helper (cinatra#1074 W5 made the semantics injectable; grant surfaces pass
    // no override and must stay behaviour-identical).
    expect(SOURCE).toMatch(/toggleSelection \?\?/);
    expect(SOURCE).toMatch(/toggleAccessSelection\(v,\s*current\)/);
    // the multi onSelect branch does NOT close the popover
    expect(SOURCE).toMatch(/Popover stays OPEN on toggle/);
    // single mode still closes on select — via the `commit` helper, which sets
    // the value then closes the popover (post-#1607 refactor).
    expect(SOURCE).toMatch(/onValueChange\(v\);\s*\n\s*setOpen\(false\);/);
  });

  it("derives row checked/disabled state from the pure accessRowState BY DEFAULT (grant mode)", () => {
    expect(SOURCE).toMatch(/\(rowState \?\? accessRowState\)\(/);
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

  it("re-exports the pure label helpers for existing callers", () => {
    expect(SOURCE).toMatch(
      /export \{ resolveAccessParts, resolveAccessSummary \} from "@\/components\/access-scope"/,
    );
  });
});
