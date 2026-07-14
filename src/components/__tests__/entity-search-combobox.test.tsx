/**
 * Source-text contract test for EntitySearchCombobox (cinatra#1509 §4.0-b).
 * Component tests in this repo lock wiring via source-file text assertions
 * (mirrors the access-combobox-*.test.tsx family); the BEHAVIOUR of the pure
 * debounce / pagination / exclusion reducers is exercised in
 * entity-search-combobox-reducer.test.ts.
 *
 * Truths locked here (the §3.4 / §3.5 interaction + perf contract this shared
 * component must own so its adopters inherit them for free):
 *  - the presentational prop contract (onSearch / onPick / renderRow / etc.)
 *  - debounce via the pure entitySearchDebounceMs (0 ms open / 300 ms typing)
 *  - stale-result ignoring on BOTH request paths (the `cancelled` flag on the
 *    first-page search AND the epoch guard on the pagination path)
 *  - the ARIA combobox wiring on the EXTERNAL input (role/aria-expanded static;
 *    aria-controls + aria-activedescendant via the in-Command bridge) and the
 *    keyboard forwarding (Arrows/Enter → cmdk root; Escape closes; Tab moves on)
 *  - open-only click (caret re-click never closes the list)
 *  - an EXPLICIT error row ("Couldn't search — try again.") DISTINCT from the
 *    empty state ("No matches.") — the panels' silent failure→empty coercion is
 *    fixed here
 *  - a loading row (Loader2 + "Searching…")
 *  - optional lazy pagination (onScroll → mergeEntityPages, limit 20 default)
 *  - the cmdk background-specificity overrides (bg-surface-strong on
 *    PopoverContent / Command / CommandList / CommandItem)
 *  - Input-anchored focus (onOpenAutoFocus prevented → focus stays in the Input)
 *  - shouldFilter={false} (server-side filtering)
 *  - module loads without throwing (import/type drift smoke)
 * BEHAVIOUR (arrow/enter selection, caret re-click, stale-page dropping) is
 * exercised for real in entity-search-combobox-interaction.test.tsx (jsdom).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/entity-search-combobox";

const SOURCE = readFileSync("src/components/entity-search-combobox.tsx", "utf-8");

describe("EntitySearchCombobox", () => {
  it("module loads and exports the component + the pure reducers", () => {
    expect(typeof Mod.EntitySearchCombobox).toBe("function");
    expect(typeof Mod.entitySearchDebounceMs).toBe("function");
    expect(typeof Mod.mergeEntityPages).toBe("function");
    expect(typeof Mod.visibleEntityResults).toBe("function");
  });

  it("exposes the presentational prop contract (onSearch / onPick / renderRow)", () => {
    expect(SOURCE).toMatch(/onSearch:\s*\(/);
    expect(SOURCE).toMatch(/onPick:\s*\(item:\s*T\)\s*=>\s*void/);
    expect(SOURCE).toMatch(/renderRow\?:\s*\(item:\s*T\)\s*=>\s*React\.ReactNode/);
    expect(SOURCE).toMatch(/excludeIds\?:\s*readonly string\[\]/);
    expect(SOURCE).toMatch(/pageSize\?:\s*number/);
  });

  it("debounces via the pure entitySearchDebounceMs (0 ms open / 300 ms typing)", () => {
    expect(Mod.entitySearchDebounceMs("")).toBe(0);
    expect(Mod.entitySearchDebounceMs("x")).toBe(300);
    expect(SOURCE).toMatch(/entitySearchDebounceMs\(query\)/);
    expect(SOURCE).toMatch(/window\.setTimeout/);
  });

  it("ignores stale / out-of-order responses via a cancelled flag (§3.4)", () => {
    expect(SOURCE).toMatch(/let cancelled = false/);
    expect(SOURCE).toMatch(/if \(cancelled\) return/);
    expect(SOURCE).toMatch(/cancelled = true/);
  });

  it("guards the PAGINATION path with a results epoch (stale page never merges)", () => {
    // The epoch bumps on every open/query transition AND on close…
    expect(SOURCE).toMatch(/const epochRef = useRef\(0\)/);
    const bumps = SOURCE.match(/epochRef\.current \+= 1/g) ?? [];
    expect(bumps.length).toBeGreaterThanOrEqual(2);
    // …and the page response is dropped when the epoch moved.
    expect(SOURCE).toMatch(/const epoch = epochRef\.current/);
    expect(SOURCE).toMatch(/if \(epochRef\.current !== epoch\) return/);
  });

  it("wires the external input as the ARIA combobox (§3.4)", () => {
    expect(SOURCE).toMatch(/role="combobox"/);
    expect(SOURCE).toMatch(/aria-expanded=\{open\}/);
    expect(SOURCE).toMatch(/aria-haspopup="listbox"/);
    expect(SOURCE).toMatch(/aria-autocomplete="list"/);
    // aria-controls + aria-activedescendant are synced by the in-Command
    // bridge (they belong to cmdk-generated ids, resolvable only after the
    // portal content mounts).
    expect(SOURCE).toMatch(/function CommandComboboxA11yBridge/);
    expect(SOURCE).toMatch(/useCommandState\(\(state\) => state\.selectedItemId\)/);
    expect(SOURCE).toMatch(/setAttribute\("aria-controls", listId\)/);
    expect(SOURCE).toMatch(/setAttribute\("aria-activedescendant", id\)/);
  });

  it("forwards ArrowUp/ArrowDown/Enter from the input to cmdk's root (§3.4 keyboard)", () => {
    expect(SOURCE).toMatch(/const forwardKeyToList = \(key: string\)/);
    expect(SOURCE).toMatch(/new KeyboardEvent\("keydown", \{ key, bubbles: true, cancelable: true \}\)/);
    // Arrows open a closed list, move the active row on an open one.
    expect(SOURCE).toMatch(/e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"/);
    // Enter selects the active row; Escape closes; Tab closes without trapping.
    expect(SOURCE).toMatch(/if \(open\) forwardKeyToList\("Enter"\)/);
    expect(SOURCE).toMatch(/e\.key === "Escape"/);
    expect(SOURCE).toMatch(/e\.key === "Tab" && open/);
  });

  it("click is open-only — a caret re-click never closes the list (finding 3)", () => {
    // The click handler opens when closed and does nothing when open.
    const click = SOURCE.slice(SOURCE.indexOf("onClick={() => {"), SOURCE.indexOf("onKeyDown={handleInputKeyDown}"));
    expect(click).toMatch(/if \(!open\) handleOpenChange\(true\);/);
    expect(click).not.toMatch(/handleOpenChange\(!open\)/);
  });

  it("renders an EXPLICIT error row distinct from the empty state (§3.4)", () => {
    expect(SOURCE).toMatch(/Couldn&apos;t search — try again\./);
    expect(SOURCE).toMatch(/setError\(true\)/);
    // The error branch is gated separately from CommandEmpty, so a failure is
    // never coerced to "No matches.".
    expect(SOURCE).toMatch(/\{error &&/);
    expect(SOURCE).toMatch(/!error && !searching && visibleResults\.length === 0/);
    expect(SOURCE).toMatch(/<CommandEmpty>\{emptyText\}<\/CommandEmpty>/);
  });

  it("renders a loading row (Loader2 + Searching…)", () => {
    expect(SOURCE).toMatch(/import \{ Loader2 \} from "lucide-react"/);
    expect(SOURCE).toMatch(/Searching…/);
  });

  it("supports optional lazy pagination (onScroll → mergeEntityPages, limit 20)", () => {
    expect(SOURCE).toMatch(/onScroll=\{handleListScroll\}/);
    expect(SOURCE).toMatch(/mergeEntityPages\(prev,\s*result\.results\)/);
    expect(SOURCE).toMatch(/DEFAULT_PAGE_SIZE = 20/);
    expect(SOURCE).toMatch(/hasMore/);
    expect(SOURCE).toMatch(/Loading more…/);
  });

  it("applies the cmdk background-specificity overrides on every cmdk node (Pitfall 5)", () => {
    // PopoverContent + Command + CommandList + CommandItem each carry
    // bg-surface-strong; at least 3 distinct bg-surface-strong applications.
    const overrides = SOURCE.match(/bg-surface-strong/g) ?? [];
    expect(overrides.length).toBeGreaterThanOrEqual(4);
    expect(SOURCE).toMatch(/shouldFilter=\{false\}/);
  });

  it("keeps focus in the anchoring Input on open (§3.4 Input-anchored typeahead)", () => {
    expect(SOURCE).toMatch(/PopoverAnchor/);
    expect(SOURCE).toMatch(/onOpenAutoFocus=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/);
  });

  it("caps the popover width to the viewport gutter (§3.5 mobile geometry)", () => {
    expect(SOURCE).toMatch(/max-w-\[min\(28rem,calc\(100vw-2rem\)\)\]/);
  });
});
