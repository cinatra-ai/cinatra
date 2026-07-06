/**
 * Source-text contract test for AccessComboboxHierarchical's flyout search ✕
 * clear button (cinatra#1014, design system §VII "Connectors").
 *
 * Component tests in this repo use source-file text assertions
 * (@testing-library/react is not available from the root package.json) —
 * mirrors access-combobox-hierarchical-disabled-scopes.test.tsx.
 *
 * Truths locked here:
 *  - the flyout search Input keeps its existing placeholder/behaviour
 *    ("stays exactly as-is" per the issue) except for the added clear
 *    affordance
 *  - a ✕ (lucide X) button appears ONLY while `search` holds a query
 *  - clicking it resets the search state to "" (clearing the filter)
 *  - the rest of the popover (grouped rows, group-only dividers,
 *    selected-row bg-surface-muted highlight) is untouched by this change
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync("src/components/access-combobox-hierarchical.tsx", "utf-8");

describe("AccessComboboxHierarchical search clear button (cinatra#1014)", () => {
  it("imports the lucide X icon", () => {
    expect(SOURCE).toMatch(/import \{ Check, ChevronDown, X \} from "lucide-react"/);
  });

  it("keeps the existing 'Search…' placeholder on the flyout search Input", () => {
    expect(SOURCE).toContain('placeholder="Search…"');
  });

  it("shows a ✕ clear button only while the search field holds a query", () => {
    expect(SOURCE).toMatch(/\{search \? \(/);
    expect(SOURCE).toMatch(/<X aria-hidden="true" \/>/);
  });

  it("renders the clear affordance as the shadcn Button wrapper, not a raw <button> (design-system gate)", () => {
    const block = SOURCE.slice(SOURCE.indexOf("{search ? ("), SOURCE.indexOf("{search ? (") + 400);
    expect(block).toMatch(/<Button\b/);
    expect(block).not.toMatch(/<button\b/);
  });

  it("clears the search state on click", () => {
    expect(SOURCE).toMatch(/onClick=\{\(\) => setSearch\(""\)\}/);
    expect(SOURCE).toContain('aria-label="Clear search"');
  });

  it("does not disturb the grouped-row / popover styling this issue leaves as-is", () => {
    // Selected/hover row highlight and group-only CommandSeparator dividers
    // are unchanged by the search-field edit.
    expect(SOURCE).toContain("hover:bg-surface-muted");
    expect(SOURCE).toContain("<CommandSeparator />");
  });
});
